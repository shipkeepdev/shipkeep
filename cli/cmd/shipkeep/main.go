// Command shipkeep is the command line client for the Shipkeep control plane REST API.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/shipkeepdev/shipkeep/cli/internal/commands"
	"github.com/shipkeepdev/shipkeep/lib/buildinfo"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

// run is separated from main so tests can drive it without spawning a process.
func run(ctx context.Context, args []string, stdin *os.File, stdout, stderr io.Writer) int {
	if len(args) == 1 && (args[0] == "--version" || args[0] == "version") {
		_, _ = fmt.Fprintln(stdout, buildinfo.String("shipkeep"))
		return 0
	}
	return commands.New(stdin, stdout, stderr).Run(ctx, args)
}
