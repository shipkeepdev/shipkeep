// Command shipkeep-agent is the node agent that runs on every server managed by Shipkeep.
//
// It reads /etc/shipkeep/agent.yaml (or --config), logs structured JSON, and stops cleanly on
// SIGINT or SIGTERM. `--dev` runs everything from a local directory for development.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/agent"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/config"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/logging"
	"github.com/samuelmbabhazi/shipkeep/lib/buildinfo"
)

// Exit codes.
const (
	exitOK     = 0
	exitError  = 1
	exitUsage  = 2
	exitConfig = 3
)

// devDir is the local directory used by --dev, relative to the working directory.
const devDir = ".shipkeep-dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	code := run(ctx, os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

type options struct {
	configPath  string
	dev         bool
	validate    bool
	showVersion bool
}

func parseFlags(args []string, stderr io.Writer) (options, error) {
	var opts options
	fs := flag.NewFlagSet("shipkeep-agent", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&opts.configPath, "config", "", "path to agent.yaml (default "+config.DefaultPath+", or "+devDir+"/agent.yaml with --dev)")
	fs.BoolVar(&opts.dev, "dev", false, "development mode: local state under ./"+devDir+", text logs, fingerprint pinning optional")
	fs.BoolVar(&opts.validate, "validate", false, "load and validate the configuration, then exit")
	fs.BoolVar(&opts.showVersion, "version", false, "print version information and exit")
	if err := fs.Parse(args); err != nil {
		return opts, fmt.Errorf("parse flags: %w", err)
	}
	if fs.NArg() > 0 {
		return opts, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	return opts, nil
}

// run executes the agent with the given arguments. It is separated from main so tests can drive
// it without spawning a process.
func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	opts, err := parseFlags(args, stderr)
	if err != nil {
		return exitUsage
	}
	if opts.showVersion {
		_, _ = fmt.Fprintln(stdout, buildinfo.String("shipkeep-agent"))
		return exitOK
	}

	cfg, err := loadConfig(opts)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "shipkeep-agent:", err)
		return exitConfig
	}
	if err := cfg.Validate(); err != nil {
		_, _ = fmt.Fprintln(stderr, "shipkeep-agent:", err)
		return exitConfig
	}
	if opts.validate {
		_, _ = fmt.Fprintln(stdout, "configuration is valid")
		return exitOK
	}

	logger, err := logging.New(stderr, cfg.Log.Level, cfg.Log.Format,
		slog.String("component", "shipkeep-agent"),
		slog.String("version", buildinfo.Version),
	)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "shipkeep-agent:", err)
		return exitConfig
	}

	a, err := agent.New(cfg, logger)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		return exitConfig
	}
	if err := a.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("agent failed", "error", err)
		return exitError
	}
	return exitOK
}

func loadConfig(opts options) (config.Config, error) {
	if opts.dev {
		base := config.DevDefault(devDir)
		if abs, err := filepath.Abs(devDir); err == nil {
			base = config.DevDefault(abs)
		}
		path := opts.configPath
		optional := path == ""
		if optional {
			path = filepath.Join(devDir, "agent.yaml")
		}
		return config.Load(path, base, optional)
	}
	path := opts.configPath
	if path == "" {
		path = config.DefaultPath
	}
	return config.Load(path, config.Default(), false)
}
