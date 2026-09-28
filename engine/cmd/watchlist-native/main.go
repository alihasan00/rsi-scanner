// Command watchlist-native runs the identical adapter outside WebAssembly for
// reproducible parity checks against the committed browser artifact.
package main

import (
	"fmt"
	"github.com/alihasan00/crypto/internal/browserengine"
	"io"
	"os"
)

func main() {
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(browserengine.RunJSON(string(input)))
}
