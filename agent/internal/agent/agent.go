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

	"github.com/shipkeepdev/shipkeep/agent/internal/config"
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
	// The reconciler keeps workloads in their recorded state even while the control plane is
	// unreachable (CLAUDE.md rule 10). It stops before the journal closes.
	reconcileCtx, stopReconcile := context.WithCancel(ctx)
	var reconciling sync.WaitGroup
	reconciling.Go(func() {
		reconcile.Reconciler{Engine: engine, State: store, Logger: a.logger}.Run(reconcileCtx)
	})
	defer func() {
		stopReconcile()
		reconciling.Wait()
	}()

	a.logger.Info("agent started",
		"version", buildinfo.Version,
		"commit", buildinfo.Commit,
		"control_plane", a.cfg.ControlPlane.Address,
		"state_dir", a.cfg.Paths.StateDir,
		"dev", a.cfg.Dev,
	)
	if a.cfg.Dev {
		a.logger.Warn("development mode: CA fingerprint pinning may be disabled, never use on a real server")
	}

	if err := a.runGateway(ctx, store, engine); err != nil && ctx.Err() == nil {
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
