// Package reconcile keeps managed containers in their recorded state without the control plane
// (PLAN M1.6): a container that should run but stopped (crash, kill, daemon restart) is started
// again, and every observation is recorded in the journal's actual state.
package reconcile

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Interval between passes (SPEC 3.5).
const Interval = 30 * time.Second

// Engine is the part of the Docker client the reconciler uses.
type Engine interface {
	Container(ctx context.Context, ref string) (docker.Container, error)
	StartContainer(ctx context.Context, id string) error
}

// State is the journal: recorded intents and observed container status.
type State interface {
	Intents(ctx context.Context) (map[string]bool, error)
	Observe(ctx context.Context, id string, status *agentv1.ContainerStatus, at time.Time) error
}

// Reconciler runs one pass per Interval until its context ends.
type Reconciler struct {
	Engine Engine
	State  State
	Logger *slog.Logger
	Now    func() time.Time
}

// Run blocks until ctx is cancelled. A failed pass is logged and retried at the next tick.
func (r Reconciler) Run(ctx context.Context) {
	ticker := time.NewTicker(Interval)
	defer ticker.Stop()
	for {
		if err := r.Pass(ctx); err != nil && ctx.Err() == nil {
			r.Logger.Warn("reconciliation pass failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Pass reconciles every recorded container once and returns how many it restarted.
func (r Reconciler) Pass(ctx context.Context) error {
	intents, err := r.State.Intents(ctx)
	if err != nil {
		return err // logged by Run without details
	}
	var failures []error
	for name, running := range intents {
		container, err := r.Engine.Container(ctx, name)
		if errors.Is(err, docker.ErrNotFound) {
			// The control plane redeploys missing containers: their secrets are not stored here.
			continue
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if container.Config.Labels[docker.ManagedLabel] != "true" {
			continue
		}
		if running && !container.State.Running {
			if err := r.Engine.StartContainer(ctx, container.ID); err != nil {
				failures = append(failures, err)
			} else {
				r.Logger.Info("restarted managed container", "container", name)
				if container, err = r.Engine.Container(ctx, name); err != nil {
					failures = append(failures, err)
					continue
				}
			}
		}
		if err := r.State.Observe(ctx, name, status(container), r.now()); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (r Reconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func status(container docker.Container) *agentv1.ContainerStatus {
	state := map[string]agentv1.ContainerStatus_State{
		"created":    agentv1.ContainerStatus_STATE_CREATED,
		"running":    agentv1.ContainerStatus_STATE_RUNNING,
		"paused":     agentv1.ContainerStatus_STATE_PAUSED,
		"restarting": agentv1.ContainerStatus_STATE_RESTARTING,
		"exited":     agentv1.ContainerStatus_STATE_EXITED,
		"dead":       agentv1.ContainerStatus_STATE_DEAD,
	}[container.State.Status]
	return &agentv1.ContainerStatus{
		ContainerId: container.ID,
		Name:        container.Name,
		State:       state,
		ExitCode:    int32(container.State.ExitCode), //nolint:gosec // process exit codes fit
		Labels:      container.Config.Labels,
	}
}
