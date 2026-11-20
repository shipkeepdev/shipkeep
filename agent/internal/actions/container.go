package actions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path"

	"google.golang.org/protobuf/proto"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// specLabel fingerprints the specification a managed container was created from.
const specLabel = "sk.spec"

var errSpecConflict = errors.New("container exists with a different specification")

// createContainer creates (never starts) a container from a fully validated spec. A replay finds
// the same container through its name and fingerprint; a different spec under the same name fails.
func createContainer(engine Engine, spec *agentv1.ContainerSpec, workloads Workloads) (journal.Plan, error) {
	name, config, err := containerConfig(spec, workloads)
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
			if err := imageVolumesMounted(ctx, engine, config); err != nil {
				return journal.Outcome{}, err
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

// causeImageVolume is the cause of a read-only-root container whose image declares a volume the
// spec does not mount (ADR 0022).
const causeImageVolume = "image_volume_undeclared"

// causeError carries a cause the dispatcher turns into a fixed text.
type causeError struct{ cause string }

func (e causeError) Error() string { return e.cause }

// Cause is the code the journal keeps and the dispatcher turns into a fixed text.
func (e causeError) Cause() string { return e.cause }

// imageVolumesMounted refuses a read-only root whose image declares a VOLUME that no mount of the
// spec covers: Docker would give that path an anonymous volume, which nothing bounds (ADR 0022).
func imageVolumesMounted(ctx context.Context, engine Engine, config docker.ContainerConfig) error {
	if !config.HostConfig.ReadonlyRootfs {
		return nil
	}
	image, err := engine.Image(ctx, config.Image)
	if err != nil {
		return fmt.Errorf("inspect image: %w", err)
	}
	mounted := map[string]bool{}
	for _, mount := range config.HostConfig.Mounts {
		mounted[path.Clean(mount.Target)] = true
	}
	for declared := range image.Config.Volumes {
		if !mounted[path.Clean(declared)] {
			return causeError{cause: causeImageVolume}
		}
	}
	return nil
}
