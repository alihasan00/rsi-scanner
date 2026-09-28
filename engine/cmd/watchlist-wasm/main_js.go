//go:build js && wasm

package main

import (
	"github.com/alihasan00/crypto/internal/browserengine"
	"syscall/js"
)

func main() {
	scan := js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) != 1 || args[0].Type() != js.TypeString {
			return browserengine.RunJSON("null")
		}
		return browserengine.RunJSON(args[0].String())
	})
	js.Global().Set("goWatchlistScan", scan)
	select {}
}
