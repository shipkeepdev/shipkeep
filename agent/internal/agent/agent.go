// Package agent wires the agent's long-running components together and owns their lifecycle.
//
// The outbound gateway connection is independent of future local journal and reconciliation loops.
package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/actions"
	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/config"
	"github.com/shipkeepdev/shipkeep/agent/internal/diskbudget"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	"github.com/shipkeepdev/shipkeep/agent/internal/reconcile"
	"github.com/shipkeepdev/shipkeep/lib/buildinfo"
)

// ShutdownTimeout bounds how long components may take to stop after a signal.
const ShutdownTimeout = 20 * time.Second

// Agent is one running agent instance.
type Agent struct {
	cfg    config.Config
	logger *slog.Logger
}

// New validates the configuration and prepares an agent. Nothing runs until Run is called.
func New(cfg config.Config, logger *slog.Logger) (*Agent, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Agent{cfg: cfg, logger: logger}, nil
}

// Run starts the agent and blocks until ctx is cancelled or a component fails. It returns nil on
// a clean shutdown.
func (a *Agent) Run(ctx context.Context) (runErr error) {
	defer func() {
		if errors.Is(runErr, context.Canceled) {
			runErr = nil
		}
	}()
	if err := a.prepareDirectories(); err != nil {
		return err
	}
	// An upgrade (ADR 0028) can end this run: a new binary that never reaches the control plane,
	// or the swap to a newer one. Both cancel ctx with their cause, read once everything stopped.
	ctx, stopRun := context.WithCancelCause(ctx)
	defer stopRun(nil)
	boot := newStartup(a.cfg.Paths.StateDir, buildinfo.Version, a.logger, nil)
	restart := newRestarter()
	watchCtx, stopWatching := context.WithCancel(ctx)
	var watching sync.WaitGroup
	watching.Go(func() {
		if err := boot.deadline(watchCtx, confirmWithin); err != nil {
			stopRun(err)
		}
	})
	watching.Go(func() {
		if err := restart.wait(watchCtx, restartWithin); err != nil {
			stopRun(err)
		}
	})
	defer func() {
		stopWatching()
		watching.Wait()
		switch cause := context.Cause(ctx); {
		case errors.Is(cause, ErrUpgradeUnconfirmed):
			runErr = ErrUpgradeUnconfirmed
		case errors.Is(cause, errRestart) && runErr == nil:
			a.logger.Info("restarting into the upgraded binary")
		}
	}()

	if ctx.Err() != nil {
		return nil
	}
	store, err := journal.Open(ctx, a.cfg.Paths.StateDir)
	if err != nil {
		return err
	}
	defer func() {
		closeErr := store.Close()
		// Filter the expected cancellation first so a close failure is never swallowed with it.
		if errors.Is(runErr, context.Canceled) {
			runErr = nil
		}
		runErr = errors.Join(runErr, closeErr)
	}()
	unfinished, err := store.Unfinished(ctx)
	if err != nil {
		return err
	}
	a.logger.Info("journal ready", "unfinished_operations", len(unfinished))
	engine, err := docker.New(a.cfg.Docker.Host)
	if err != nil {
		return err
	}
	// One Caddy client for the whole agent: its lock orders every read-then-write on routes, so the
	// control plane's route keeper, the reconciler and the route actions must share it.
	router, err := caddy.New(a.cfg.Caddy.AdminSocket)
	if err != nil {
		return err
	}
	// The route actions and the refresher share one book: a route and its record change together.
	routes := &actions.RouteBook{Store: store}
	// The reconciler keeps workloads in their recorded state even while the control plane is
	// unreachable (CLAUDE.md rule 10), routes included: a container restarted at another address
	// keeps receiving its own traffic (ADR 0017). It stops before the journal closes.
	reconcileCtx, stopReconcile := context.WithCancel(ctx)
	var reconciling sync.WaitGroup
	reconciling.Go(func() {
		refresher := actions.RouteRefresher{Router: router, Containers: engine, Book: routes}
		reconcile.Reconciler{Engine: engine, State: store, Routes: refresher, Logger: a.logger}.Run(reconcileCtx)
	})
	defer func() {
		stopReconcile()
		reconciling.Wait()
	}()
	// On the machine that hosts the control plane, its route lives in the agent (ADR 0021).
	if route := a.cfg.ControlPlane.Route; route.Host != "" {
		reconciling.Go(func() {
			keepControlPlaneRoute(reconcileCtx, router, caddy.ControlPlaneRoutes(route.Host, route.Upstream), a.cfg.Intervals.Reconcile, time.Second, a.logger)
		})
	}
	// The disk budget of each container (ADR 0022), enforced on the node alone as well.
	reconciling.Go(func() {
		diskbudget.Watcher{Engine: engine, State: store, Logger: a.logger}.Run(reconcileCtx)
	})

	a.logger.Info("agent started",
		"version", buildinfo.Version,
		"commit", buildinfo.Commit,
		"control_plane", a.cfg.ControlPlane.Address,
		"control_plane_connect", a.cfg.ControlPlane.Connect,
		"state_dir", a.cfg.Paths.StateDir,
		"dev", a.cfg.Dev,
	)
	if a.cfg.Dev {
		a.logger.Warn("development mode: CA fingerprint pinning may be disabled, never use on a real server")
	}
	// systemd learns the agent runs; an upgraded binary waits for the control plane's welcome.
	boot.started()

	if err := a.runGateway(ctx, store, engine, router, routes, boot, restart); err != nil && ctx.Err() == nil {
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), ShutdownTimeout)
	defer cancel()
	if err := a.shutdown(shutdownCtx); err != nil {
		return err
	}
	a.logger.Info("agent stopped")
	return nil
}

func (a *Agent) prepareDirectories() error {
	for _, dir := range []string{a.cfg.Paths.StateDir, a.cfg.Paths.RunDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
		info, err := os.Stat(dir)
		if err != nil {
			return fmt.Errorf("stat %s: %w", dir, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("%s is not a directory", dir)
		}
		// The state directory holds certificates and the journal: it must not be group or world
		// accessible even when it pre-existed with looser permissions.
		if dir == a.cfg.Paths.StateDir && info.Mode().Perm()&0o077 != 0 {
			if err := os.Chmod(dir, 0o700); err != nil { //nolint:gosec // 0700 on a directory is the restrictive choice
				return fmt.Errorf("restrict %s: %w", dir, err)
			}
		}
	}
	// A write probe fails early and loudly when the service user cannot own its state.
	probe := filepath.Join(a.cfg.Paths.StateDir, ".write-test")
	if err := os.WriteFile(probe, nil, 0o600); err != nil {
		return fmt.Errorf("state directory is not writable: %w", err)
	}
	if err := os.Remove(probe); err != nil {
		return fmt.Errorf("clean write probe: %w", err)
	}
	return nil
}

func (a *Agent) shutdown(ctx context.Context) error {
	// Components are stopped here in reverse start order once they exist.
	if err := ctx.Err(); err != nil && !errors.Is(err, context.Canceled) {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}
