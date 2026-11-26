package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"maps"
	"slices"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/actions"
	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/config"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
)

// exitRefused: some routes could not be tied to their containers and were left without a record.
const exitRefused = 5

// adoptTimeout bounds the whole adoption: a few reads of Caddy and Docker, and one write per route.
const adoptTimeout = 2 * time.Minute

// runAdoptRoutes records the routes that agents up to 0.1.0-alpha.3 wrote without a record, so
// that they follow their containers (ADR 0017). The server installer's migration runs it as the
// agent's account, with the agent stopped and before Docker restarts (ADR 0028); the journal's lock
// refuses it while an agent runs. It prints application ids and reason codes, never addresses.
func runAdoptRoutes(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("shipkeep-agent adopt-routes", flag.ContinueOnError)
	fs.SetOutput(stderr)
	path := fs.String("config", config.DefaultPath, "path to agent.yaml")
	if err := fs.Parse(args); err != nil {
		return exitUsage
	}
	if fs.NArg() > 0 || *path == "" {
		_, _ = fmt.Fprintln(stderr, "shipkeep-agent adopt-routes: unexpected arguments")
		return exitUsage
	}
	cfg, err := config.Load(*path, config.Default(), false)
	if err == nil {
		err = cfg.Validate()
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "shipkeep-agent adopt-routes:", err)
		return exitConfig
	}
	ctx, cancel := context.WithTimeout(ctx, adoptTimeout)
	defer cancel()
	adoption, err := adoptRoutes(ctx, cfg)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "shipkeep-agent adopt-routes:", err)
		return exitError
	}
	_, _ = fmt.Fprintf(stdout, "routes: %d already followed, %d adopted, %d refused\n", len(adoption.Followed), len(adoption.Adopted), len(adoption.Refused))
	for _, application := range slices.Sorted(maps.Keys(adoption.Refused)) {
		_, _ = fmt.Fprintf(stdout, "refused: application %s (%s)\n", application, adoption.Refused[application])
	}
	if len(adoption.Refused) > 0 {
		return exitRefused
	}
	return exitOK
}

func adoptRoutes(ctx context.Context, cfg config.Config) (actions.Adoption, error) {
	store, err := journal.Open(ctx, cfg.Paths.StateDir)
	if err != nil {
		return actions.Adoption{}, fmt.Errorf("open the journal (is the agent stopped?): %w", err)
	}
	defer func() { _ = store.Close() }()
	engine, err := docker.New(cfg.Docker.Host)
	if err != nil {
		return actions.Adoption{}, fmt.Errorf("docker: %w", err)
	}
	router, err := caddy.New(cfg.Caddy.AdminSocket)
	if err != nil {
		return actions.Adoption{}, fmt.Errorf("caddy: %w", err)
	}
	adoption, err := actions.AdoptRoutes(ctx, router, engine, &actions.RouteBook{Store: store}, time.Now())
	if err != nil {
		return actions.Adoption{}, fmt.Errorf("adopt routes: %w", err)
	}
	return adoption, nil
}
