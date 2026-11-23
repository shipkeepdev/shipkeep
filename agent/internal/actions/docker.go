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

	"github.com/shipkeepdev/shipkeep/agent/internal/confirm"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/shipkeepdev/shipkeep/lib/secret"
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
	Proxies(ctx context.Context) (docker.Proxies, error)
	Container(ctx context.Context, ref string) (docker.Container, error)
	CreateContainer(ctx context.Context, name string, config docker.ContainerConfig) (string, error)
	StartContainer(ctx context.Context, id string) error
	StopContainer(ctx context.Context, id string, timeout int) error
	RemoveContainer(ctx context.Context, id string, volumes bool) error
	WaitContainer(ctx context.Context, id string) (int, error)
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

// Intents records whether managed containers should run; the reconciler restores it (M1.6).
type Intents interface {
	SetIntent(ctx context.Context, container string, running bool, now time.Time) error
	ClearIntent(ctx context.Context, container string) error
}

// DockerHandlers returns the Docker-backed handlers; health probes go over container networks.
func DockerHandlers(engine Engine, confirmations Confirmer, intents Intents, options ...Option) map[string]Handler {
	return dockerHandlers(engine, confirmations, NetworkProber{}, intents, options...)
}

// Option changes how the Docker handlers behave.
type Option func(*handlerOptions)

type handlerOptions struct {
	egressUnchecked bool
	reservedHosts   []string
	workloads       Workloads
	routeBook       *RouteBook
}

// Workloads places application containers on the machine that hosts the control plane (ADR 0021):
// in a slice whose memory the installer limits, and first in the kernel's kill order. The values
// come from the agent's local configuration, never from the control plane.
type Workloads struct {
	// Slice is the systemd slice of every container the agent creates; empty keeps Docker's default.
	Slice string
	// OOMScoreAdj is the containers' oom_score_adj; nil keeps the kernel's default.
	OOMScoreAdj *int
}

// WithWorkloads creates every application and release-task container under w.
func WithWorkloads(w Workloads) Option {
	return func(o *handlerOptions) { o.workloads = w }
}

// WithReservedHosts refuses every route for these host names, or a wildcard that covers one: the
// control plane's name on the machine that hosts it (ADR 0021), whose route the agent keeps itself.
func WithReservedHosts(hosts ...string) Option {
	return func(o *handlerOptions) { o.reservedHosts = append(o.reservedHosts, hosts...) }
}

// WithRouteBook records the routes to local containers, for reconciliation, in the book the
// refresher shares (ADR 0017).
func WithRouteBook(book *RouteBook) Option {
	return func(o *handlerOptions) { o.routeBook = book }
}

// WithoutEgressCheck lets pulls run without the daemon going through the egress proxy. Only an
// agent started with --dev uses it, on a machine without the proxy (ADR 0023).
func WithoutEgressCheck() Option {
	return func(o *handlerOptions) { o.egressUnchecked = true }
}

// EgressProxy is the proxy the daemon must use for every pull: the egress service on the node
// (ADR 0023, agent/internal/egress).
const EgressProxy = "http://127.0.0.1:7480"

// causeEgressUnguarded is the cause of a pull refused because the daemon does not go through
// the egress proxy.
const causeEgressUnguarded = "egress_unguarded"

// egressGuarded checks the daemon's effective proxy settings before a pull: both proxies are the
// egress service and nothing bypasses it. Anything else, or a daemon that does not answer, refuses
// the pull: the proxy is what keeps a registry from pointing the daemon at the node's network.
func egressGuarded(ctx context.Context, engine Engine) error {
	proxies, err := engine.Proxies(ctx)
	if err != nil {
		return fmt.Errorf("read daemon proxy settings: %w", err)
	}
	if proxies.HTTP != EgressProxy || proxies.HTTPS != EgressProxy || proxies.No != "" {
		return causeError{cause: causeEgressUnguarded}
	}
	return nil
}

func dockerHandlers(engine Engine, confirmations Confirmer, prober Prober, intents Intents, options ...Option) map[string]Handler {
	var settings handlerOptions
	for _, option := range options {
		option(&settings)
	}
	return map[string]Handler{
		"health_check": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return healthCheck(engine, prober, req.GetHealthCheck())
		}, Result: healthResult},
		"run_release_task": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return releaseTask(engine, req.GetRunReleaseTask(), settings.workloads)
		}, Result: releaseResult},
		"remove_volume": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return removeVolume(engine, confirmations, req.GetRemoveVolume())
		}, Result: resourceResult},
		"ensure_network": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return ensureNetwork(engine, req.GetEnsureNetwork())
		}, Result: resourceResult},
		"pull_image": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return pullImage(engine, req.GetPullImage(), !settings.egressUnchecked)
		}, Result: digestResult},
		"ensure_volume": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return ensureVolume(engine, req.GetEnsureVolume())
		}, Result: resourceResult},
		"create_container": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return createContainer(engine, req.GetCreateContainer().GetSpec(), settings.workloads)
		}, Result: resourceResult},
		"start_container": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return startContainer(engine, intents, req.GetStartContainer())
		}, Result: resourceResult},
		"stop_container": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return stopContainer(engine, intents, req.GetStopContainer())
		}, Result: resourceResult},
		"remove_container": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return removeContainer(engine, confirmations, intents, req.GetRemoveContainer())
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

func pullImage(engine Engine, action *agentv1.PullImage, checkEgress bool) (journal.Plan, error) {
	ref := action.GetImageRef()
	match := imageRef.FindStringSubmatch(ref)
	if len(ref) > maxImageRef || match == nil {
		return journal.Plan{}, errInput
	}
	registry := registryOf(strings.TrimSuffix(match[1], "/"))
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
			if checkEgress {
				if err := egressGuarded(ctx, engine); err != nil {
					return journal.Outcome{}, err
				}
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

// dockerHub is the name Docker Hub credentials are stored and sent under (ADR 0019).
const dockerHub = "docker.io"

// registryOf names the registry a reference is pulled from, the way the Docker daemon reads it:
// the first path component is a host only when it holds a dot or a port, or is localhost.
// Anything else is a Docker Hub namespace, so credentials named "acme" never match "acme/app".
func registryOf(first string) string {
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		return first
	}
	return dockerHub
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
