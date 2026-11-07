// Package buildinfo exposes the version information stamped into Shipkeep binaries at build time.
//
// The variables are set through -ldflags "-X github.com/shipkeepdev/shipkeep/lib/buildinfo.Version=..."
// by GoReleaser (task M8.2). Development builds report "dev".
package buildinfo

import "fmt"

// Values overridden at link time. Keep them as plain strings so -X works.
var (
	// Version is the semantic version of the release, for example "0.1.0".
	Version = "dev"
	// Commit is the full git commit hash the binary was built from.
	Commit = "unknown"
	// Date is the build timestamp in RFC 3339 format.
	Date = "unknown"
)

// String returns a single-line, human-readable description of the build.
func String(component string) string {
	return fmt.Sprintf("%s %s (commit %s, built %s)", component, Version, Commit, Date)
}
