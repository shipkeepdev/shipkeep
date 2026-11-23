// Command gen writes trusted_root.json, the Sigstore trusted root that each agent build embeds to
// verify a release offline (ADR 0028). It reads it through Sigstore's TUF repository, which checks
// it against the TUF root that sigstore-go carries. Run it with `go generate ./agent/internal/upgrade`
// to take a newer root; the file is committed.
package main

import (
	"fmt"
	"os"

	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "gen:", err)
		os.Exit(1)
	}
}

func run() error {
	options := tuf.DefaultOptions()
	options.DisableLocalCache = true
	client, err := tuf.New(options)
	if err != nil {
		return fmt.Errorf("tuf client: %w", err)
	}
	data, err := client.GetTarget("trusted_root.json")
	if err != nil {
		return fmt.Errorf("trusted root: %w", err)
	}
	// It must parse as a trusted root before it is written.
	if _, err := root.NewTrustedRootFromJSON(data); err != nil {
		return fmt.Errorf("parse trusted root: %w", err)
	}
	return os.WriteFile("trusted_root.json", data, 0o644) //nolint:gosec // public key material, read by everyone
}
