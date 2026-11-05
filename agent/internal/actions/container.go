package actions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"google.golang.org/protobuf/proto"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

// specLabel fingerprints the specification a managed container was created from.
const specLabel = "sk.spec"

var errSpecConflict = errors.New("container exists with a different specification")

// createContainer creates (never starts) a container from a fully validated spec. A replay finds
// the same container through its name and fingerprint; a different spec under the same name fails.
func createContainer(engine Engine, spec *agentv1.ContainerSpec) (journal.Plan, error) {
	name, config, err := containerConfig(spec)
	if err != nil {
		return journal.Plan{}, err
	}
	fingerprint, err := specFingerprint(spec)
	if err != nil {
		return journal.Plan{}, errInput
	}
	config.Labels[specLabel] = fingerprint
	return journal.Plan{Version: "create-container-v1", Steps: []journal.Step{{
		Name:      "create",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			existing, err := engine.Container(ctx, name)
			switch {
			case err == nil:
				return reuse(existing, fingerprint)
			case !errors.Is(err, docker.ErrNotFound):
				return journal.Outcome{}, fmt.Errorf("inspect container: %w", err)
			}
			id, err := engine.CreateContainer(ctx, name, config)
			if err != nil {
				return journal.Outcome{}, fmt.Errorf("create container: %w", err)
			}
			return journal.Outcome{ResourceID: id}, nil
		},
		// Undo only what this plan created: a managed container carrying this exact fingerprint.
		Compensate: func(ctx context.Context) error {
			existing, err := engine.Container(ctx, name)
			if errors.Is(err, docker.ErrNotFound) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("inspect container: %w", err)
			}
			if existing.Config.Labels[docker.ManagedLabel] != "true" || existing.Config.Labels[specLabel] != fingerprint {
				return nil
			}
			if err := engine.RemoveContainer(ctx, existing.ID, false); err != nil && !errors.Is(err, docker.ErrNotFound) {
				return fmt.Errorf("remove container: %w", err)
			}
			return nil
		},
	}}}, nil
}

func reuse(existing docker.Container, fingerprint string) (journal.Outcome, error) {
	labels := existing.Config.Labels
	switch {
	case labels[docker.ManagedLabel] != "true":
		return journal.Outcome{}, errForeign
	case labels[specLabel] != fingerprint:
		return journal.Outcome{}, errSpecConflict
	default:
		return journal.Outcome{ResourceID: existing.ID}, nil
	}
}

// specFingerprint hashes the spec with every secret value replaced by its version, so the label
// visible through `docker inspect` reveals nothing about secret values.
func specFingerprint(spec *agentv1.ContainerSpec) (string, error) {
	clone, ok := proto.Clone(spec).(*agentv1.ContainerSpec)
	if !ok {
		return "", errors.New("clone container spec")
	}
	for _, secret := range clone.GetSecrets() {
		secret.Value = nil
	}
	data, err := proto.MarshalOptions{Deterministic: true}.Marshal(clone)
	if err != nil {
		return "", fmt.Errorf("encode container spec: %w", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
