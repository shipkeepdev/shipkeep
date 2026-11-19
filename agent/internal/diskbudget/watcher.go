// Package diskbudget stops a managed container whose writable layer outgrew its disk budget
// (ADR 0022). It runs on the node alone, like the reconciler, so a control plane outage does not
// suspend it.
package diskbudget

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/actions"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
)

const (
	// Interval between two measurements: Docker walks every writable layer to answer.
	Interval = time.Minute
	// StopSeconds is the grace period of a disk stop, whatever the container's own stop timeout:
	// it keeps writing until it is killed.
	StopSeconds = 5
	// Reason is the stop reason recorded and reported for such a stop.
	Reason = "disk_limit"
	// The budgets the agent accepts when it creates a container; a label outside them is not one
	// the agent wrote, and is ignored.
	minBudget = 64 << 20
	maxBudget = 1 << 40
)

// Engine is the part of the Docker client the watcher uses.
type Engine interface {
	ManagedContainersWithSize(ctx context.Context) ([]docker.ContainerSummary, error)
	StopContainer(ctx context.Context, id string, timeout int) error
}

// State records what the watcher decided, before it acts: the intent first, so the reconciler
// never starts the container again, then the reason, which the state report carries.
type State interface {
	SetIntent(ctx context.Context, container string, running bool, now time.Time) error
	RecordStopReason(ctx context.Context, container, reason string, now time.Time) error
}

// Watcher measures the managed containers every Interval until its context ends.
type Watcher struct {
	Engine   Engine
	State    State
	Logger   *slog.Logger
	Interval time.Duration
	Now      func() time.Time
}

// Run measures until ctx ends; a failed pass is logged and the next one runs on time.
func (w Watcher) Run(ctx context.Context) {
	interval := w.Interval
	if interval <= 0 {
		interval = Interval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.Pass(ctx); err != nil && ctx.Err() == nil {
				// Docker's error text can carry paths; the pass reports a fixed message.
				w.Logger.Warn("disk budget check failed; retrying at the next interval")
			}
		}
	}
}

// Pass measures every running managed container once and stops each one above its budget.
func (w Watcher) Pass(ctx context.Context) error {
	containers, err := w.Engine.ManagedContainersWithSize(ctx)
	if err != nil {
		return errors.New("cannot measure managed containers")
	}
	now := time.Now
	if w.Now != nil {
		now = w.Now
	}
	var failures []error
	for _, container := range containers {
		if container.Labels[docker.ManagedLabel] != "true" || container.State != "running" || len(container.Names) != 1 {
			continue
		}
		budget, ok := Budget(container.Labels[actions.DiskBudgetLabel])
		if !ok || container.SizeRw <= 0 || uint64(container.SizeRw) <= budget {
			continue
		}
		name := strings.TrimPrefix(container.Names[0], "/")
		if err := w.State.SetIntent(ctx, name, false, now()); err != nil {
			failures = append(failures, err)
			continue
		}
		if err := w.State.RecordStopReason(ctx, name, Reason, now()); err != nil {
			failures = append(failures, err)
			continue
		}
		if err := w.Engine.StopContainer(ctx, container.ID, StopSeconds); err != nil {
			failures = append(failures, errors.New("cannot stop a container over its disk budget"))
			continue
		}
		// Name, budget and size only: never a path or anything the application wrote.
		w.Logger.Warn("stopped a container over its disk budget", "container", name,
			"budget_bytes", budget, "size_bytes", container.SizeRw)
	}
	return errors.Join(failures...)
}

// Budget reads the label the agent set at creation: false when there is none, or when it is not
// a budget the agent would have written.
func Budget(label string) (uint64, bool) {
	if label == "" || len(label) > 20 {
		return 0, false
	}
	budget, err := strconv.ParseUint(label, 10, 64)
	if err != nil || budget < minBudget || budget > maxBudget || strconv.FormatUint(budget, 10) != label {
		return 0, false
	}
	return budget, true
}
