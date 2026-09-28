package market

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

//go:embed symbols_snapshot.ts
var bundledSymbols string

var symbolsDeclaration = regexp.MustCompile(`(?m)^\s*export\s+const\s+SYMBOLS(?:\s*:[^=\n]+)?\s*=\s*\[`)

// LoadSymbols defaults to the versioned embedded universe on every host. An
// explicit path can contain TypeScript source, a JSON array or a text list; a
// mutable sibling checkout never changes the default universe implicitly.
func LoadSymbols(path string) ([]string, string, error) {
	if path == "" {
		symbols, err := parseSymbols(bundledSymbols)
		return symbols, "bundled rsi-scanner snapshot (2026-09-25)", err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, "", fmt.Errorf("resolve symbols path: %w", err)
	}
	data, err := os.ReadFile(absolute)
	if err != nil {

		return nil, "", fmt.Errorf("read symbols %s: %w", absolute, err)
	}
	if len(data) > 1<<20 {
		return nil, "", errors.New("symbol source exceeds 1 MiB")
	}
	symbols, err := parseSymbols(string(data))
	if err != nil {
		return nil, "", fmt.Errorf("parse symbols %s: %w", absolute, err)
	}
	return symbols, absolute, nil
}

func parseSymbols(source string) ([]string, error) {
	var raw []string
	trimmed := strings.TrimSpace(source)
	if bounds := symbolsDeclaration.FindStringIndex(source); bounds != nil {
		var err error
		raw, err = parseTypeScriptArray(source[bounds[1]:])
		if err != nil {
			return nil, err
		}
	} else if strings.HasPrefix(trimmed, "[") {
		if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
			return nil, fmt.Errorf("invalid JSON symbol list: %w", err)
		}
	} else {
		for _, line := range strings.Split(source, "\n") {
			if index := strings.Index(line, "#"); index >= 0 {
				line = line[:index]
			}
			if index := strings.Index(line, "//"); index >= 0 {
				line = line[:index]
			}
			raw = append(raw, strings.FieldsFunc(line, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })...)
		}
	}
	seen := make(map[string]bool, len(raw))
	symbols := make([]string, 0, len(raw))
	for _, value := range raw {
		symbol, err := normalizeSymbol(value)
		if err != nil {
			return nil, err
		}
		if !seen[symbol] {
			seen[symbol] = true
			symbols = append(symbols, symbol)
		}
	}
	if len(symbols) == 0 {
		return nil, errors.New("symbol list is empty")
	}
	return symbols, nil
}

func normalizeSymbol(value string) (string, error) {
	symbol := strings.ToUpper(strings.TrimSpace(value))
	if len(symbol) <= 4 || len(symbol) > 128 || !strings.HasSuffix(symbol, "USDT") || !utf8.ValidString(symbol) {
		return "", fmt.Errorf("invalid Binance USDT symbol %q", value)
	}
	for _, r := range symbol {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return "", fmt.Errorf("invalid Binance USDT symbol %q", value)
		}
	}
	return symbol, nil
}

// parseTypeScriptArray handles string literals and comments without evaluating
// source code or accidentally treating symbols in comments as actual entries.
func parseTypeScriptArray(source string) ([]string, error) {
	var symbols []string
	expectValue := true
	for {
		source = strings.TrimLeftFunc(source, unicode.IsSpace)
		if strings.HasPrefix(source, "//") {
			if end := strings.IndexByte(source, '\n'); end >= 0 {
				source = source[end+1:]
				continue
			}
			return nil, errors.New("unterminated SYMBOLS array")
		}
		if strings.HasPrefix(source, "/*") {
			end := strings.Index(source[2:], "*/")
			if end < 0 {
				return nil, errors.New("unterminated symbol source comment")
			}
			source = source[end+4:]
			continue
		}
		if len(source) == 0 {
			return nil, errors.New("unterminated SYMBOLS array")
		}
		if source[0] == ']' {
			return symbols, nil
		}
		if !expectValue {
			if source[0] != ',' {
				return nil, errors.New("expected comma in SYMBOLS array")
			}
			source = source[1:]
			expectValue = true
			continue
		}
		quote := source[0]
		if quote != '\'' && quote != '"' {
			return nil, errors.New("SYMBOLS entries must be string literals")
		}
		source = source[1:]
		var value strings.Builder
		for len(source) > 0 && source[0] != quote {
			r, _, tail, err := strconv.UnquoteChar(source, quote)
			if err != nil {
				return nil, errors.New("invalid SYMBOLS string literal")
			}
			value.WriteRune(r)
			source = tail
		}
		if len(source) == 0 {
			return nil, errors.New("unterminated SYMBOLS string literal")
		}
		symbols = append(symbols, value.String())
		source = source[1:]
		expectValue = false
	}
}
