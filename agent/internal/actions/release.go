package actions

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

const (
	defaultReleaseTimeout = 10 * time.Minute
	maxReleaseTimeout     = time.Hour
)

var errReleaseTimeout = errors.New("release task timed out")

// releaseTask runs a one-off container (for example migrations) once: create, run until exit
// within the timeout, record the exit code, remove. It never restarts.
func releaseTask(engine Engine, action *agentv1.RunReleaseTask) (journal.Plan, error) {
	name, config, err := containerConfig(action.GetSpec())
	if err != nil {
		return journal.Plan{}, err
	}
	timeout := defaultReleaseTimeout
	if value := action.GetTimeout(); value != nil {
		timeout = value.AsDuration()
		if value.CheckValid() != nil || timeout < time.Second || timeout > maxReleaseTimeout {
			return journal.Plan{}, errInput
		}
	}
	config.HostConfig.RestartPolicy = docker.RestartPolicy{Name: "no"}
	fingerprint, err := specFingerprint(action.GetSpec())
	if err != nil {
		return journal.Plan{}, errInput
	}
	config.Labels[specLabel] = fingerprint
	remove := func(ctx context.Context) error {
		existing, err := engine.Container(ctx, name)
		if errors.Is(err, docker.ErrNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("inspect release task: %w", err)
		}
		if existing.Config.Labels[docker.ManagedLabel] != "true" || existing.Config.Labels[specLabel] != fingerprint {
			return nil
		}
		if err := engine.RemoveContainer(ctx, existing.ID, false); err != nil && !errors.Is(err, docker.ErrNotFound) {
			return fmt.Errorf("remove release task: %w", err)
		}
		return nil
	}
	return journal.Plan{Version: "release-task-v1", Steps: []journal.Step{
		{
			Name:      "create",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				existing, err := engine.Container(ctx, name)
				switch {
				case err == nil:
					return reuse(existing, fingerprint)
				case !errors.Is(err, docker.ErrNotFound):
					return journal.Outcome{}, fmt.Errorf("inspect release task: %w", err)
				}
				id, err := engine.CreateContainer(ctx, name, config)
				if err != nil {
					return journal.Outcome{}, fmt.Errorf("create release task: %w", err)
				}
				return journal.Outcome{ResourceID: id}, nil
			},
			Compensate: remove,
		},
		{
			// Not retry-safe: restarting an interrupted task could run a migration twice. The
			// container is removed in the same step so the exit code is the final outcome.
			Name: "run",
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				existing, err := engine.Container(ctx, name)
				if err != nil {
					return journal.Outcome{}, errMissing
				}
				if _, err := reuse(existing, fingerprint); err != nil {
					return journal.Outcome{}, err
				}
				if err := engine.StartContainer(ctx, existing.ID); err != nil {
					return journal.Outcome{}, fmt.Errorf("start release task: %w", err)
				}
				waitCtx, cancel := context.WithTimeout(ctx, timeout)
				defer cancel()
				code, err := engine.WaitContainer(waitCtx, existing.ID)
				cleanupCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
				defer stop()
				if err != nil {
					_ = engine.StopContainer(cleanupCtx, existing.ID, 0)
					if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
						return journal.Outcome{}, errReleaseTimeout
					}
					return journal.Outcome{}, fmt.Errorf("wait for release task: %w", err)
				}
				if err := remove(cleanupCtx); err != nil {
					return journal.Outcome{}, err
				}
				return journal.Outcome{ResourceID: existing.ID, ExitCode: int32(code)}, nil //nolint:gosec // process exit codes fit
			},
			Compensate: remove,
		},
	}}, nil
}

func releaseResult(outcome journal.Outcome) *agentv1.ActionResult {
	return &agentv1.ActionResult{Result: &agentv1.ActionResult_ReleaseTask{ReleaseTask: &agentv1.ActionResult_ReleaseTaskResult{ExitCode: outcome.ExitCode}}}
}
