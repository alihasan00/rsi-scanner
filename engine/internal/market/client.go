package market

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const DefaultBaseURL = "https://api.binance.com/api/v3"

// ErrHistoryGap distinguishes missing provider bars from transient transport
// failures. Callers must not silently bridge these gaps or fabricate candles.
var ErrHistoryGap = errors.New("non-contiguous provider candle history")

// SupportedIntervals contains Binance Spot's supported kline intervals. Month
// intervals are case sensitive: 1M is one month, while 1m is one minute.
var SupportedIntervals = []string{
	"1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M",
}

// Client is safe for concurrent use. Use one shared client for a scan so all
// workers share request pacing and exchange rate-limit cooldowns.
type Client struct {
	baseURL          string
	httpClient       *http.Client
	mu               sync.Mutex
	nextRequest      time.Time
	cooldownUntil    time.Time
	requestSpacing   time.Duration
	retryBackoff     time.Duration
	operationTimeout time.Duration
	maxAttempts      int
	now              func() time.Time
	waiters          []chan struct{}
}

// NewClient uses the rsi-scanner Binance Spot endpoint when baseURL is empty.
// A supplied HTTP client is copied so adding a timeout never changes its owner.
func NewClient(baseURL string, httpClient *http.Client) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	client := http.Client{Timeout: 15 * time.Second}
	if httpClient != nil {
		client = *httpClient
		if client.Timeout <= 0 {
			client.Timeout = 15 * time.Second
		}
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"), httpClient: &client,
		requestSpacing: 125 * time.Millisecond, retryBackoff: time.Second,
		operationTimeout: 45 * time.Second, maxAttempts: 3, now: time.Now,
	}
}

// Candles returns closed bars separately from the newest, provisional bar.
// Binance REST has no final flag. As in rsi-scanner, only a later bar proves a
// bar is closed; the local clock never promotes the newest bar to closed.
func (c *Client) Candles(ctx context.Context, symbol, interval string, limit int) ([]Candle, *Candle, error) {
	return c.candles(ctx, symbol, interval, nil, limit)
}

// CandlesSince reads at most limit bars beginning at startTime (inclusive).
// The last bar remains provisional, including on historical pagination pages;
// request the following page starting at that bar to prove its finality.
func (c *Client) CandlesSince(ctx context.Context, symbol, interval string, startTime int64, limit int) ([]Candle, *Candle, error) {
	if startTime < 0 || startTime > 1<<53-1 {
		return nil, nil, errors.New("invalid candle start time")
	}
	return c.candles(ctx, symbol, interval, &startTime, limit)
}

func (c *Client) candles(ctx context.Context, symbol, interval string, startTime *int64, limit int) ([]Candle, *Candle, error) {
	symbol, err := normalizeSymbol(symbol)
	if err != nil {
		return nil, nil, err
	}
	if !supportedInterval(interval) {
		return nil, nil, fmt.Errorf("unsupported Binance interval %q", interval)
	}
	if limit < 1 || limit > 1000 {
		return nil, nil, fmt.Errorf("candle limit must be between 1 and 1000")
	}
	endpoint, err := url.Parse(c.baseURL + "/klines")
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return nil, nil, fmt.Errorf("invalid Binance base URL")
	}
	query := endpoint.Query()
	query.Set("symbol", symbol)
	query.Set("interval", interval)
	query.Set("limit", strconv.Itoa(limit))
	if startTime != nil {
		query.Set("startTime", strconv.FormatInt(*startTime, 10))
	}
	endpoint.RawQuery = query.Encode()
	ctx, cancel := context.WithTimeout(ctx, c.operationTimeout)
	defer cancel()
	transportRetries := 0
	for attempt := 0; attempt < c.maxAttempts; attempt++ {
		if err := c.waitForSlot(ctx); err != nil {
			return nil, nil, fmt.Errorf("fetch %s candles: %w", symbol, err)
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return nil, nil, err
		}
		request.Header.Set("Accept", "application/json")
		response, err := c.httpClient.Do(request)
		if err != nil {
			if transportRetries == 0 && attempt+1 < c.maxAttempts && ctx.Err() == nil && retryableTransport(err) {
				transportRetries++
				if err := c.waitRetry(ctx); err != nil {
					return nil, nil, err
				}
				continue
			}
			return nil, nil, fmt.Errorf("fetch %s candles: %w", symbol, err)
		}
		if response.StatusCode == http.StatusOK {
			// A 1,000-bar response is well below this bound. The extra byte
			// distinguishes an oversized body from a truncated JSON document.
			const maxBodyBytes = 4 << 20
			body, readErr := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes+1))
			response.Body.Close()
			if readErr != nil {
				if transportRetries == 0 && attempt+1 < c.maxAttempts && ctx.Err() == nil && retryableTransport(readErr) {
					transportRetries++
					if err := c.waitRetry(ctx); err != nil {
						return nil, nil, err
					}
					continue
				}
				return nil, nil, fmt.Errorf("read %s candles: %w", symbol, readErr)
			}
			if len(body) > maxBodyBytes {
				return nil, nil, fmt.Errorf("%s candle response exceeds size limit", symbol)
			}
			closed, preview, parseErr := parseKlines(body)
			if parseErr != nil {
				return nil, nil, fmt.Errorf("%s candles: %w", symbol, parseErr)
			}
			if err := validateResponse(closed, preview, interval, c.now(), startTime == nil); err != nil {
				return nil, nil, fmt.Errorf("%s %s candles: %w", symbol, interval, err)
			}
			return closed, preview, nil
		}
		// Drain small exchange errors to allow connection reuse, without
		// exposing arbitrary upstream response content in the application's UI.
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		statusErr := fmt.Errorf("Binance HTTP %d for %s", response.StatusCode, symbol)
		retry := response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusTeapot || response.StatusCode >= 500
		if !retry {
			return nil, nil, statusErr
		}
		delay := c.retryBackoff * time.Duration(1<<attempt)
		// Bans need a substantial cooldown even when no Retry-After is sent.
		if response.StatusCode == http.StatusTeapot && delay < time.Minute {
			delay = time.Minute
		}
		if requested := retryAfter(response.Header.Get("Retry-After"), time.Now()); requested > delay {
			delay = requested
		}
		c.deferRequests(delay)
		if attempt == c.maxAttempts-1 {
			return nil, nil, statusErr
		}
	}
	return nil, nil, errors.New("candle request attempts exhausted")
}

func supportedInterval(interval string) bool {
	// Keep validation independent of mutation of the exported display list.
	switch interval {
	case "1s", "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M":
		return true
	default:
		return false
	}
}

func (c *Client) waitForSlot(ctx context.Context) error {
	// Explicit FIFO admission prevents bulk reconciliation workers from
	// repeatedly winning the pacer's timer race ahead of older requests.
	turn := make(chan struct{})
	c.mu.Lock()
	c.waiters = append(c.waiters, turn)
	if len(c.waiters) == 1 {
		close(turn)
	}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for i, waiter := range c.waiters {
			if waiter == turn {
				c.waiters = append(c.waiters[:i], c.waiters[i+1:]...)
				if i == 0 && len(c.waiters) > 0 {
					close(c.waiters[0])
				}
				break
			}
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-turn:
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		c.mu.Lock()
		now := time.Now()
		next := c.nextRequest
		if c.cooldownUntil.After(next) {
			next = c.cooldownUntil
		}
		if !next.After(now) {
			c.nextRequest = now.Add(c.requestSpacing)
			c.mu.Unlock()
			return nil
		}
		c.mu.Unlock()
		timer := time.NewTimer(time.Until(next))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func retryableTransport(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError) && (networkError.Timeout() || networkError.Temporary())
}

func (c *Client) waitRetry(ctx context.Context) error {
	timer := time.NewTimer(time.Duration(float64(c.retryBackoff) * (0.5 + rand.Float64())))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Client) deferRequests(delay time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	until := time.Now().Add(delay)
	if until.After(c.cooldownUntil) {
		c.cooldownUntil = until
	}
}

func retryAfter(value string, now time.Time) time.Duration {
	if seconds, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64); err == nil && seconds > 0 {
		// Preserve long exchange bans while preventing duration overflow.
		// Each caller still has its own bounded operation deadline.
		const maxSeconds = int64((1<<63 - 1) / time.Second)
		if seconds > maxSeconds {
			seconds = maxSeconds
		}
		return time.Duration(seconds) * time.Second
	}
	if until, err := http.ParseTime(value); err == nil && until.After(now) {
		return until.Sub(now)
	}
	return 0
}

func parseKlines(body []byte) ([]Candle, *Candle, error) {
	var rows [][]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(body))
	if err := decoder.Decode(&rows); err != nil {
		return nil, nil, fmt.Errorf("invalid kline JSON: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, nil, errors.New("unexpected data after kline JSON")
	}
	if len(rows) == 0 {
		return nil, nil, errors.New("no kline data")
	}
	candles := make([]Candle, len(rows))
	for i, row := range rows {
		if len(row) < 7 {
			return nil, nil, fmt.Errorf("kline %d has fewer than seven fields", i)
		}
		candle := &candles[i]
		var err error
		if candle.OpenTime, err = integerField(row[0]); err != nil {
			return nil, nil, fmt.Errorf("invalid open time at kline %d", i)
		}
		if candle.CloseTime, err = integerField(row[6]); err != nil {
			return nil, nil, fmt.Errorf("invalid close time at kline %d", i)
		}
		for index, target := range []*float64{&candle.Open, &candle.High, &candle.Low, &candle.Close, &candle.Volume} {
			*target, err = decimalField(row[index+1])
			if err != nil {
				return nil, nil, fmt.Errorf("invalid price or volume at kline %d", i)
			}
		}
		if !candle.Valid() {
			return nil, nil, fmt.Errorf("invalid OHLCV or timestamp at kline %d", i)
		}
		if i > 0 && candle.OpenTime != candles[i-1].CloseTime+1 {
			return nil, nil, fmt.Errorf("%w at kline %d", ErrHistoryGap, i)
		}
	}
	last := candles[len(candles)-1]
	return candles[:len(candles)-1], &last, nil
}

func numberText(raw json.RawMessage) (string, error) {
	if len(raw) > 0 && raw[0] == '"' {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return "", err
		}
		return value, nil
	}
	return string(raw), nil
}

func integerField(raw json.RawMessage) (int64, error) {
	value, err := numberText(raw)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(value, 10, 64)
}

func decimalField(raw json.RawMessage) (float64, error) {
	value, err := numberText(raw)
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(value, 64)
}
