// Command shipkeep-agent is the node agent that runs on every server managed by Shipkeep.
//
// Task M0.1 only provides the binary skeleton. The real agent (configuration, logging,
// mTLS stream, operation journal) arrives with milestone M1.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/samuelmbabhazi/shipkeep/lib/buildinfo"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses the command line and executes the agent. It is separated from main so tests
// can drive it without spawning a process.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("shipkeep-agent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	showVersion := fs.Bool("version", false, "print version information and exit")

	if err := fs.Parse(args); err != nil {
		return 2
	}

	if *showVersion {
		_, _ = fmt.Fprintln(stdout, buildinfo.String("shipkeep-agent"))
		return 0
	}

	_, _ = fmt.Fprintln(stderr, "shipkeep-agent: not implemented yet (see docs/PLAN.md, milestone M1)")
	return 1
}
