package actions

import (
	"context"
	"errors"
	"fmt"
	"regexp"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/confirm"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

// containerRef is a full Docker id or a Shipkeep container name; id prefixes are never accepted.
var containerRef = regexp.MustCompile(`^(?:[a-f0-9]{64}|sk-[a-z0-9-]{1,60})$`)

const defaultStopSeconds = 10

var errMissing = errors.New("container not found")

// managed inspects ref and returns it only when the agent manages it.
func managed(ctx context.Context, engine Engine, ref string) (docker.Container, error) {
	container, err := engine.Container(ctx, ref)
	if err != nil {
		return docker.Container{}, err // callers map not-found themselves
	}
	if container.Config.Labels[docker.ManagedLabel] != "true" {
		return docker.Container{}, errForeign
	}
	return container, nil
}

func startContainer(engine Engine, action *agentv1.StartContainer) (journal.Plan, error) {
	ref := action.GetContainerId()
	if !containerRef.MatchString(ref) {
		return journal.Plan{}, errInput
	}
	return journal.Plan{Version: "start-container-v1", Steps: []journal.Step{{
		Name:      "start",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			container, err := managed(ctx, engine, ref)
			if errors.Is(err, docker.ErrNotFound) {
				return journal.Outcome{}, errMissing
			}
			if err != nil {
				return journal.Outcome{}, err
			}
			if err := engine.StartContainer(ctx, container.ID); err != nil {
				return journal.Outcome{}, fmt.Errorf("start container: %w", err)
			}
			return journal.Outcome{ResourceID: container.ID}, nil
		},
		// A started container is the wanted end state; stopping is a separate action.
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

func stopContainer(engine Engine, action *agentv1.StopContainer) (journal.Plan, error) {
	ref := action.GetContainerId()
	seconds := defaultStopSeconds
	if timeout := action.GetStopTimeout(); timeout != nil {
		value := timeout.AsDuration().Seconds()
		if timeout.CheckValid() != nil || value < 0 || value > maxStopSeconds {
			return journal.Plan{}, errInput
		}
		seconds = int(value)
	}
	if !containerRef.MatchString(ref) {
		return journal.Plan{}, errInput
	}
	return journal.Plan{Version: "stop-container-v1", Steps: []journal.Step{{
		Name:      "stop",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			container, err := managed(ctx, engine, ref)
			if errors.Is(err, docker.ErrNotFound) {
				return journal.Outcome{}, nil // nothing left to stop
			}
			if err != nil {
				return journal.Outcome{}, err
			}
			if err := engine.StopContainer(ctx, container.ID, seconds); err != nil && !errors.Is(err, docker.ErrNotFound) {
				return journal.Outcome{}, fmt.Errorf("stop container: %w", err)
			}
			return journal.Outcome{ResourceID: container.ID}, nil
		},
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

// removeContainer removes a managed container. Removing its volumes destroys data and needs a
// `container.remove` confirmation for that container, spent in a non-retryable first step.
func removeContainer(engine Engine, confirmations Confirmer, action *agentv1.RemoveContainer) (journal.Plan, error) {
	ref, volumes, token := action.GetContainerId(), action.GetRemoveVolumes(), action.GetConfirmationToken()
	if !containerRef.MatchString(ref) || (volumes && (confirmations == nil || !confirm.Wellformed(token))) || (!volumes && token != "") {
		return journal.Plan{}, errInput
	}
	steps := []journal.Step{}
	if volumes {
		steps = append(steps, journal.Step{
			Name: "confirm",
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				if err := confirmations.Consume(ctx, token, "container.remove", ref); err != nil {
					return journal.Outcome{}, fmt.Errorf("confirmation: %w", err)
				}
				return journal.Outcome{}, nil
			},
			Compensate: func(context.Context) error { return nil },
		})
	}
	steps = append(steps, journal.Step{
		Name:      "remove",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			container, err := managed(ctx, engine, ref)
			if errors.Is(err, docker.ErrNotFound) {
				return journal.Outcome{}, nil
			}
			if err != nil {
				return journal.Outcome{}, err
			}
			if err := engine.RemoveContainer(ctx, container.ID, volumes); err != nil && !errors.Is(err, docker.ErrNotFound) {
				return journal.Outcome{}, fmt.Errorf("remove container: %w", err)
			}
			return journal.Outcome{ResourceID: container.ID}, nil
		},
		Compensate: func(context.Context) error { return nil },
	})
	return journal.Plan{Version: "remove-container-v1", Steps: steps}, nil
}
