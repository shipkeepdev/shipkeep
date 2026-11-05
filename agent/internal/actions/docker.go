package actions

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/confirm"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/samuelmbabhazi/shipkeep/lib/secret"
)

// Engine is the part of the Docker client the handlers use; tests substitute a fake daemon.
type Engine interface {
	NetworkByName(ctx context.Context, name string) (docker.Network, error)
	CreateNetwork(ctx context.Context, name string, internal bool, labels map[string]string) (string, error)
	Volume(ctx context.Context, name string) (docker.Volume, error)
	CreateVolume(ctx context.Context, name string, labels map[string]string) error
	RemoveVolume(ctx context.Context, name string) error
	Image(ctx context.Context, ref string) (docker.Image, error)
	PullImage(ctx context.Context, repository, digest string, auth *docker.Auth) error
	Container(ctx context.Context, ref string) (docker.Container, error)
	CreateContainer(ctx context.Context, name string, config docker.ContainerConfig) (string, error)
	StartContainer(ctx context.Context, id string) error
	StopContainer(ctx context.Context, id string, timeout int) error
	RemoveContainer(ctx context.Context, id string, volumes bool) error
}

var (
	// resourceName is the SPEC 3.3 grammar for networks and volumes.
	resourceName = regexp.MustCompile(`^sk-[a-z0-9-]{1,60}$`)
	// imageRef is a lowercase repository with optional registry host and port, pinned by digest.
	imageRef   = regexp.MustCompile(`^((?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::[0-9]{1,5})?/)?([a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$`)
	labelKey   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)
	errInput   = errors.New("invalid action input")
	errForeign = errors.New("resource exists but is not managed by Shipkeep")
)

const (
	maxImageRef = 512
	maxLabels   = 16
)

// Confirmer spends a confirmation token for one action on one target (SPEC 3.6).
type Confirmer interface {
	Consume(ctx context.Context, token, action, target string) error
}

// DockerHandlers returns the network, image and volume handlers backed by engine.
func DockerHandlers(engine Engine, confirmations Confirmer) map[string]Handler {
	return map[string]Handler{
		"remove_volume": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return removeVolume(engine, confirmations, req.GetRemoveVolume())
		}, Result: resourceResult},
		"ensure_network": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return ensureNetwork(engine, req.GetEnsureNetwork())
		}, Result: resourceResult},
		"pull_image": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) { return pullImage(engine, req.GetPullImage()) }, Result: digestResult},
		"ensure_volume": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return ensureVolume(engine, req.GetEnsureVolume())
		}, Result: resourceResult},
		"create_container": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return createContainer(engine, req.GetCreateContainer().GetSpec())
		}, Result: resourceResult},
	}
}

func ensureNetwork(engine Engine, action *agentv1.EnsureNetwork) (journal.Plan, error) {
	name := action.GetName()
	if !resourceName.MatchString(name) {
		return journal.Plan{}, errInput
	}
	return journal.Plan{Version: "ensure-network-v1", Steps: []journal.Step{{
		Name:      "ensure",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			existing, err := engine.NetworkByName(ctx, name)
			switch {
			case err == nil:
				if existing.Labels[docker.ManagedLabel] != "true" {
					return journal.Outcome{}, errForeign
				}
				return journal.Outcome{ResourceID: existing.ID}, nil
			case !errors.Is(err, docker.ErrNotFound):
				return journal.Outcome{}, fmt.Errorf("inspect network: %w", err)
			}
			id, err := engine.CreateNetwork(ctx, name, action.GetInternal(), map[string]string{docker.ManagedLabel: "true"})
			if err != nil {
				return journal.Outcome{}, fmt.Errorf("create network: %w", err)
			}
			return journal.Outcome{ResourceID: id}, nil
		},
		// Ensuring is idempotent and a leftover empty network is harmless: nothing to undo.
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

func pullImage(engine Engine, action *agentv1.PullImage) (journal.Plan, error) {
	ref := action.GetImageRef()
	match := imageRef.FindStringSubmatch(ref)
	if len(ref) > maxImageRef || match == nil {
		return journal.Plan{}, errInput
	}
	registry := strings.TrimSuffix(match[1], "/")
	repository, digest := strings.TrimSuffix(ref, "@"+match[3]), match[3]
	auth, err := registryAuth(action.GetRegistryCredentials(), registry)
	if err != nil {
		return journal.Plan{}, err
	}
	return journal.Plan{Version: "pull-image-v1", Steps: []journal.Step{{
		Name:      "pull",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			if present(ctx, engine, ref) {
				return journal.Outcome{Digest: digest}, nil
			}
			if err := engine.PullImage(ctx, repository, digest, auth); err != nil {
				return journal.Outcome{}, fmt.Errorf("pull image: %w", err)
			}
			if !present(ctx, engine, ref) {
				return journal.Outcome{}, errors.New("pulled image does not carry the requested digest")
			}
			return journal.Outcome{Digest: digest}, nil
		},
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

// present checks that the local image is exactly ref (repository and digest).
func present(ctx context.Context, engine Engine, ref string) bool {
	image, err := engine.Image(ctx, ref)
	return err == nil && slices.Contains(image.RepoDigests, ref)
}

// registryAuth accepts only short-lived credentials for the image's own registry.
func registryAuth(credentials *agentv1.RegistryCredentials, registry string) (*docker.Auth, error) {
	if credentials == nil {
		return nil, nil //nolint:nilnil // no credentials is a valid anonymous pull
	}
	expires := credentials.GetExpiresAt()
	if registry == "" || credentials.GetServer() != registry ||
		!printable(credentials.GetUsername(), 256) || credentials.GetUsername() == "" ||
		credentials.GetPassword() == "" || len(credentials.GetPassword()) > 4096 ||
		expires == nil || !expires.AsTime().After(time.Now()) {
		return nil, errInput
	}
	return &docker.Auth{Server: registry, Username: credentials.GetUsername(), Password: secret.NewString(credentials.GetPassword())}, nil
}

func ensureVolume(engine Engine, action *agentv1.EnsureVolume) (journal.Plan, error) {
	name := action.GetName()
	labels, err := volumeLabels(action.GetLabels())
	if !resourceName.MatchString(name) || err != nil {
		return journal.Plan{}, errInput
	}
	return journal.Plan{Version: "ensure-volume-v1", Steps: []journal.Step{{
		Name:      "ensure",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			existing, err := engine.Volume(ctx, name)
			switch {
			case err == nil:
				if existing.Labels[docker.ManagedLabel] != "true" {
					return journal.Outcome{}, errForeign
				}
				return journal.Outcome{ResourceID: name}, nil
			case !errors.Is(err, docker.ErrNotFound):
				return journal.Outcome{}, fmt.Errorf("inspect volume: %w", err)
			}
			if err := engine.CreateVolume(ctx, name, labels); err != nil {
				return journal.Outcome{}, fmt.Errorf("create volume: %w", err)
			}
			return journal.Outcome{ResourceID: name}, nil
		},
		// Never delete data to undo an ensure: removal is a confirmed, separate action.
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

// removeVolume deletes a managed volume after spending a confirmation for exactly that volume.
// The token is checked for shape here and verified and spent in the first journaled step.
func removeVolume(engine Engine, confirmations Confirmer, action *agentv1.RemoveVolume) (journal.Plan, error) {
	name, token := action.GetName(), action.GetConfirmationToken()
	if !resourceName.MatchString(name) || confirmations == nil || !confirm.Wellformed(token) {
		return journal.Plan{}, errInput
	}
	return journal.Plan{Version: "remove-volume-v1", Steps: []journal.Step{
		{
			// Not retry-safe: after an uncertain crash the token may be spent, so the operation
			// fails and a new confirmation is required.
			Name: "confirm",
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				if err := confirmations.Consume(ctx, token, "volume.remove", name); err != nil {
					return journal.Outcome{}, fmt.Errorf("confirmation: %w", err)
				}
				return journal.Outcome{}, nil
			},
			Compensate: func(context.Context) error { return nil },
		},
		{
			Name:      "remove",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				existing, err := engine.Volume(ctx, name)
				switch {
				case errors.Is(err, docker.ErrNotFound):
					return journal.Outcome{ResourceID: name}, nil
				case err != nil:
					return journal.Outcome{}, fmt.Errorf("inspect volume: %w", err)
				case existing.Labels[docker.ManagedLabel] != "true":
					return journal.Outcome{}, errForeign
				}
				if err := engine.RemoveVolume(ctx, name); err != nil && !errors.Is(err, docker.ErrNotFound) {
					return journal.Outcome{}, fmt.Errorf("remove volume: %w", err)
				}
				return journal.Outcome{ResourceID: name}, nil
			},
			// Deleted data cannot be restored here; restores are separate, confirmed actions.
			Compensate: func(context.Context) error { return nil },
		},
	}}, nil
}

// volumeLabels validates caller labels; the `sk.` namespace is reserved for the agent.
func volumeLabels(input map[string]string) (map[string]string, error) {
	if len(input) > maxLabels {
		return nil, errInput
	}
	labels := maps.Clone(input)
	if labels == nil {
		labels = map[string]string{}
	}
	for key, value := range labels {
		if !labelKey.MatchString(key) || strings.HasPrefix(key, "sk.") || !printable(value, 256) {
			return nil, errInput
		}
	}
	labels[docker.ManagedLabel] = "true"
	return labels, nil
}

func printable(value string, limit int) bool {
	return len(value) <= limit && !strings.ContainsFunc(value, func(r rune) bool { return !unicode.IsPrint(r) })
}

func resourceResult(outcome journal.Outcome) *agentv1.ActionResult {
	return &agentv1.ActionResult{Result: &agentv1.ActionResult_ContainerId{ContainerId: outcome.ResourceID}}
}

func digestResult(outcome journal.Outcome) *agentv1.ActionResult {
	return &agentv1.ActionResult{Result: &agentv1.ActionResult_ImageDigest{ImageDigest: outcome.Digest}}
}
