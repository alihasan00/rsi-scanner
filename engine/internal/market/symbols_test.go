package market

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseSymbolFormatsAndUnicode(t *testing.T) {
	want := []string{"BTCUSDT", "币安人生USDT", "ETHUSDT"}
	for name, input := range map[string]string{
		"typescript": `// 'IGNOREUSDT' should not be included.
export const SYMBOLS: readonly string[] = [
  'BTCUSDT', // 'COMMENTUSDT'
  /* 'ALSOIGNOREUSDT' */ "币安人生USDT", 'ETHUSDT', 'BTCUSDT',
]`,
		"json": `["BTCUSDT", "币安人生USDT", "ETHUSDT", "BTCUSDT"]`,
		"text": "btcusdt,币安人生USDT\n# comment\nETHUSDT // inline comment\nBTCUSDT",
	} {
		t.Run(name, func(t *testing.T) {
			got, err := parseSymbols(input)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("got=%v want=%v err=%v", got, want, err)
			}
		})
	}
}

func TestParseSymbolSourceRejectsMalformedInput(t *testing.T) {
	for _, input := range []string{
		"", "[]", "# only comment", `["BTCUSDT", null]`, `["BTCUSDT", 3]`, "BTC/USDT", "USDT", "BTCUSDT&limit=1000", "BTCUSD",
		`export const SYMBOLS = ['BTCUSDT' 'ETHUSDT']`,
		`export const SYMBOLS = ['BTCUSDT', getSymbol()]`,
		`export const SYMBOLS = ['BTCUSDT',`,
		`export const SYMBOLS = ['BTCUSDT', /*`,
		`export const SYMBOLS = ['BTCUSDT', // no end`,
		`export const SYMBOLS = ['BTCUSDT]`,
		`export const SYMBOLS = [, 'BTCUSDT']`,
	} {
		if _, err := parseSymbols(input); err == nil {
			t.Errorf("accepted malformed source: %s", input)
		}
	}
}

func TestBundledSymbolsSnapshot(t *testing.T) {
	symbols, err := parseSymbols(bundledSymbols)
	if err != nil {
		t.Fatal(err)
	}
	if len(symbols) != 110 || symbols[0] != "BTCUSDT" || symbols[len(symbols)-1] != "FFUSDT" {
		t.Fatalf("unexpected bundled universe: count=%d", len(symbols))
	}
	found := false
	for _, symbol := range symbols {
		if symbol == "币安人生USDT" {
			found = true
		}
	}
	if !found {
		t.Fatal("bundled universe lost Unicode pair")
	}
}

func TestLoadSymbolsExplicitPathAndErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "symbols.txt")
	if err := os.WriteFile(path, []byte("BTCUSDT\nETHUSDT\n"), 0600); err != nil {
		t.Fatal(err)
	}
	symbols, provenance, err := LoadSymbols(path)
	if err != nil || !reflect.DeepEqual(symbols, []string{"BTCUSDT", "ETHUSDT"}) || provenance != path {
		t.Fatalf("symbols=%v provenance=%s err=%v", symbols, provenance, err)
	}
	if _, _, err := LoadSymbols(filepath.Join(dir, "missing.ts")); err == nil {
		t.Fatal("explicit missing file silently fell back")
	}
	if err := os.WriteFile(path, []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadSymbols(path); err == nil {
		t.Fatal("explicit malformed file silently fell back")
	}
}

func TestDefaultUniverseDoesNotDependOnSiblingCheckout(t *testing.T) {
	base := t.TempDir()
	project := filepath.Join(base, "crypto")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(project)
	symbols, provenance, err := LoadSymbols("")
	if err != nil || len(symbols) != 110 || !strings.HasPrefix(provenance, "bundled ") {
		t.Fatalf("fallback: count=%d source=%s err=%v", len(symbols), provenance, err)
	}
	canonical := filepath.Join(base, "rsi-scanner", "src", "lib", "symbols.ts")
	if err := os.MkdirAll(filepath.Dir(canonical), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(canonical, []byte(`export const SYMBOLS = ['SOLUSDT', '币安人生USDT']`), 0600); err != nil {
		t.Fatal(err)
	}
	symbols, provenance, err = LoadSymbols("")
	if err != nil || len(symbols) != 110 || !strings.HasPrefix(provenance, "bundled ") {
		t.Fatalf("sibling checkout changed default: symbols=%v source=%s err=%v", symbols, provenance, err)
	}
	explicit, source, err := LoadSymbols(canonical)
	if err != nil || !reflect.DeepEqual(explicit, []string{"SOLUSDT", "币安人生USDT"}) || source != canonical {
		t.Fatalf("explicit override failed: %v %s %v", explicit, source, err)
	}
	if err := os.WriteFile(canonical, []byte("invalid source"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadSymbols(""); err != nil {
		t.Fatal("unrelated malformed sibling affected default universe")
	}
	if _, _, err := LoadSymbols(canonical); err == nil {
		t.Fatal("malformed explicit source accepted")
	}
}
