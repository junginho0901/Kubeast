// Command schemagen writes the public JSON Schema of the dashboard document.
// Run it from the module root after changing internal/model:
//
//	go run ./cmd/schemagen
//
// internal/schema's test fails while the committed file differs.
package main

import (
	"fmt"
	"os"

	"github.com/junginho0901/kubeast/services/dashboards-service-go/internal/schema"
)

func main() {
	b, err := schema.Generate()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(schema.Path, b, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
