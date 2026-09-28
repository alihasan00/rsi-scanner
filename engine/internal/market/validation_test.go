package market

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type testTransport func(*http.Request) (*http.Response, error)

func (f testTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLatestRESTRejectsWrongIntervalStaleAndFuture(t *testing.T) {
	for _, tc := range []struct {
		name, interval string
		now            time.Time
	}{
		{"wrong interval", "1h", time.UnixMilli(90000)},
		{"stale", "1m", time.UnixMilli(300000)},
		{"future", "1m", time.UnixMilli(1000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := NewClient("https://fixture.invalid", &http.Client{Transport: testTransport(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(sampleKlines)), Header: make(http.Header), Request: r}, nil
			})})
			client.now = func() time.Time { return tc.now }
			if _, _, err := client.Candles(context.Background(), "BTCUSDT", tc.interval, 10); err == nil {
				t.Fatal("incorrect current-market evidence accepted")
			}
		})
	}
}

func TestRESTTransportRetryIsBoundedAndCancellationIsTerminal(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want int32
	}{
		{"EOF", io.EOF, 2},
		{"cancelled", context.Canceled, 1},
		{"certificate or permanent error", errors.New("invalid certificate"), 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			client := NewClient("https://fixture.invalid", &http.Client{Transport: testTransport(func(*http.Request) (*http.Response, error) {
				calls.Add(1)
				return nil, tc.err
			})})
			client.requestSpacing, client.retryBackoff = 0, time.Millisecond
			if _, _, err := client.Candles(context.Background(), "BTCUSDT", "1m", 10); err == nil || calls.Load() != tc.want {
				t.Fatalf("calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestFIFOAdmissionRemovesCancelledWaiters(t *testing.T) {
	c := NewClient("", nil)
	c.requestSpacing = time.Millisecond
	c.nextRequest = time.Now().Add(30 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.waitForSlot(ctx) }()
	for {
		c.mu.Lock()
		queued := len(c.waiters) == 1
		c.mu.Unlock()
		if queued {
			break
		}
		time.Sleep(time.Millisecond)
	}
	second := make(chan error, 1)
	go func() { second <- c.waitForSlot(context.Background()) }()
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	select {
	case err := <-second:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled head stranded the request queue")
	}
}
