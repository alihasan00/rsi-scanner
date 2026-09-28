package market

import (
	"encoding/json"
	"reflect"
	"testing"
)

func FuzzParseKlines(f *testing.F) {
	for _, seed := range []string{sampleKlines, "[]", "null", `[[0,"NaN","2","1","1","0",59999]]`, `[[1704067200000,"100","120","90","110","1",1706745599999],[1706745600000,"100","120","90","110","1",1709251199999]]`, sampleKlines + "[]"} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > 1<<16 {
			t.Skip()
		}
		closed, preview, err := parseKlines(input)
		if err != nil {
			return
		}
		if preview == nil || !preview.Valid() {
			t.Fatal("successful parse produced invalid provisional candle")
		}
		for i, candle := range closed {
			if !candle.Valid() || i > 0 && candle.OpenTime != closed[i-1].CloseTime+1 {
				t.Fatal("successful parse produced malformed or discontinuous history")
			}
		}
		if len(closed) > 0 && preview.OpenTime != closed[len(closed)-1].CloseTime+1 {
			t.Fatal("preview separated from history")
		}
	})
}

func FuzzParseSymbols(f *testing.F) {
	for _, seed := range []string{`["BTCUSDT","币安人生USDT"]`, "BTCUSDT,ETHUSDT\nBTCUSDT", "export const SYMBOLS = ['BTCUSDT', /*comment*/ 'ETHUSDT']", "export const SYMBOLS = [", "\xffUSDT"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		if len(input) > 1<<16 {
			t.Skip()
		}
		symbols, err := parseSymbols(input)
		if err != nil {
			return
		}
		seen := map[string]bool{}
		for _, symbol := range symbols {
			canonical, err := normalizeSymbol(symbol)
			if err != nil || canonical != symbol || seen[symbol] {
				t.Fatal("accepted noncanonical or duplicate symbol")
			}
			seen[symbol] = true
		}
		encoded, err := json.Marshal(symbols)
		if err != nil {
			t.Fatal(err)
		}
		roundtrip, err := parseSymbols(string(encoded))
		if err != nil || !reflect.DeepEqual(symbols, roundtrip) {
			t.Fatal("canonical symbols did not round-trip")
		}
	})
}
