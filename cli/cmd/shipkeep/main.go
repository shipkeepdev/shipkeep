// Command shipkeep is the command line client for the Shipkeep control plane REST API.
//
// Task M0.1 only provides the binary skeleton. The real CLI (login, init, deploy, rollback, logs, status and more)
// arrives with task M8.2.
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

// run parses the command line and executes the CLI. It is separated from main so tests
// can drive it without spawning a process.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("shipkeep", flag.ContinueOnError)
	fs.SetOutput(stderr)
	showVersion := fs.Bool("version", false, "print version information and exit")

	if err := fs.Parse(args); err != nil {
		return 2
	}

	if *showVersion {
		_, _ = fmt.Fprintln(stdout, buildinfo.String("shipkeep"))
		return 0
	}

	_, _ = fmt.Fprintln(stderr, "shipkeep: not implemented yet (see docs/PLAN.md, task M8.2)")
	return 1
}
