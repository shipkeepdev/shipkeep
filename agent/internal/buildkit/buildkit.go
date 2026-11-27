// Package buildkit drives the server's rootless BuildKit daemon over its gRPC socket (ADR 0030):
// it fetches a repository at a commit, builds it with a Dockerfile, Railpack or Nixpacks, and
// pushes the image to the installation's registry. It never runs a process on the host and never
// touches the Docker daemon; Railpack and Nixpacks run inside BuildKit, from images and binaries
// pinned here. Requests arrive validated by the BuildImage action.
package buildkit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"strings"

	"github.com/moby/buildkit/client"
	"github.com/moby/buildkit/client/llb"
	"github.com/moby/buildkit/exporter/containerimage/exptypes"
	"github.com/moby/buildkit/session"
	"github.com/moby/buildkit/session/auth"
	"github.com/moby/buildkit/session/secrets/secretsprovider"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

// ErrUnavailable is a daemon that does not answer: not installed, stopped, or its socket gone.
var ErrUnavailable = errors.New("buildkit daemon unavailable")

var digestFormat = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Kind is what turns the repository into an image (ADR 0030).
type Kind int

const (
	// Dockerfile builds with BuildKit's own Dockerfile frontend.
	Dockerfile Kind = iota
	// Railpack builds with the plan Railpack writes, through Railpack's frontend.
	Railpack
	// Nixpacks builds the Dockerfile Nixpacks writes.
	Nixpacks
)

// Request is one build, as the BuildImage action validated it.
type Request struct {
	// Kind is the builder: a Dockerfile, Railpack or Nixpacks.
	Kind Kind
	// CacheNamespace keeps the application's cache mounts its own; Client.Build sets it.
	CacheNamespace string
	// Repository is an HTTPS Git URL, without credentials.
	Repository string
	// Commit is the full commit hash fetched.
	Commit string
	// Token reads the repository; zero for a public one. It reaches BuildKit as a session secret
	// under a name of this build's own, never as a build argument or in a URL.
	Token secret.String
	// Context is the build context's directory in the repository, relative; empty for its root.
	Context string
	// Dockerfile is the Dockerfile's path, relative to Context. Dockerfile builds only.
	Dockerfile string
	// Args are the build arguments. Railpack serves them as build secrets, as Railway does;
	// Nixpacks declares them in its Dockerfile, which also sets them in the image's environment.
	Args map[string]string
	// Target is the reference pushed: the registry's host, the repository and a tag.
	Target string
	// Registry is what the push authenticates with, for Target's host only.
	Registry Credentials
}

// Credentials are a user name and password for one registry host.
type Credentials struct {
	Host     string
	Username string
	Password secret.String
}

// Client builds with the daemon at Address, `unix:///…` for its socket.
type Client struct {
	Address string
	// WorkDir holds the copy of the repository and the plan a Railpack build reads from this
	// server's disk, for that build only. A server runs one build at a time (ADR 0032), so each
	// build empties it first, of whatever an interrupted build left.
	WorkDir string
	// CacheSecret keys the applications' cache namespaces (LoadCacheSecret).
	CacheSecret []byte
}

// Build runs the build and pushes the image, sending each line of its output to line, and answers
// the pushed manifest's digest.
func (c Client) Build(ctx context.Context, request Request, line func(string)) (string, error) {
	if len(c.CacheSecret) == 0 {
		return "", errors.New("the agent has no build cache key")
	}
	request.CacheNamespace = CacheNamespace(c.CacheSecret, request.Target)
	// One build at a time (ADR 0032): what is here was left by a build an agent restart cut.
	if c.WorkDir != "" {
		if err := os.RemoveAll(c.WorkDir); err != nil {
			return "", fmt.Errorf("clear the build directory: %w", err)
		}
	}
	daemon, err := client.New(ctx, c.Address)
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	defer daemon.Close() //nolint:errcheck // nothing to do about a failed close
	tokenName, err := randomName("sk-git-")
	if err != nil {
		return "", err
	}
	headerName, err := randomName("sk-git-header-")
	if err != nil {
		return "", err
	}
	fetch := []session.Attachable{
		secretsprovider.FromMap(secrets(request.Token, tokenName)),
		&registryAuth{credentials: request.Registry},
	}
	output := newPrinter(line)
	var response *client.SolveResponse
	switch request.Kind {
	case Railpack:
		response, err = c.railpack(ctx, daemon, request, gitSource(request, tokenName, headerName), fetch, output)
	case Nixpacks:
		options := client.SolveOpt{Exports: pushTo(request.Target), Session: fetch}
		build := nixpacksBuild(request, gitSource(request, tokenName, headerName), runtime.GOARCH)
		response, err = solve(output, func(progress chan *client.SolveStatus) (*client.SolveResponse, error) {
			return daemon.Build(ctx, options, "", build, progress)
		})
	case Dockerfile:
		options := SolveOptions(request, tokenName, headerName)
		options.Session = fetch
		response, err = solve(output, func(progress chan *client.SolveStatus) (*client.SolveResponse, error) {
			return daemon.Solve(ctx, nil, options, progress)
		})
	default:
		return "", fmt.Errorf("unknown build kind %d", request.Kind)
	}
	if err != nil {
		if code := status.Code(errors.Unwrap(err)); code == codes.Unavailable || status.Code(err) == codes.Unavailable {
			return "", fmt.Errorf("%w: %w", ErrUnavailable, err)
		}
		return "", fmt.Errorf("build: %w", err)
	}
	digest := response.ExporterResponse[exptypes.ExporterImageDigestKey]
	if !digestFormat.MatchString(digest) {
		return "", errors.New("the build pushed no image digest")
	}
	return digest, nil
}

// solve runs one solve, its progress printed as lines. BuildKit closes progress when it ends.
func solve(output *printer, run func(chan *client.SolveStatus) (*client.SolveResponse, error)) (*client.SolveResponse, error) {
	progress := make(chan *client.SolveStatus)
	printed := make(chan struct{})
	go func() {
		defer close(printed)
		for update := range progress {
			output.update(update)
		}
		output.flush()
	}()
	response, err := run(progress)
	<-printed
	return response, err
}

// gitSource is the repository at the commit, its context directory only, fetched by BuildKit
// with the token served under this build's own secret names.
func gitSource(request Request, tokenName, headerName string) llb.State {
	gitOptions := []llb.GitOption{
		llb.GitRef(request.Commit),
		llb.AuthTokenSecret(tokenName),
		// The default header secret name is not served: only this build's own names are.
		llb.AuthHeaderSecret(headerName),
	}
	if request.Context != "" {
		gitOptions = append(gitOptions, llb.GitSubDir(request.Context))
	}
	return llb.Git(request.Repository, "", gitOptions...)
}

// pushTo is the image export that pushes target.
func pushTo(target string) []client.ExportEntry {
	return []client.ExportEntry{{
		Type:  client.ExporterImage,
		Attrs: map[string]string{"name": target, "push": "true"},
	}}
}

// SolveOptions is the build without its session: the repository at the commit, as the context
// and as the Dockerfile's source, BuildKit's Dockerfile frontend, and a push of Target.
func SolveOptions(request Request, tokenName, headerName string) client.SolveOpt {
	source := gitSource(request, tokenName, headerName)
	attrs := map[string]string{"filename": request.Dockerfile}
	for name, value := range request.Args {
		attrs["build-arg:"+name] = value
	}
	// The Dockerfile's cache mounts are the application's own (BuildKit's namespace for them).
	attrs["build-arg:BUILDKIT_CACHE_MOUNT_NS"] = request.CacheNamespace
	return client.SolveOpt{
		Frontend:       "dockerfile.v0",
		FrontendAttrs:  attrs,
		FrontendInputs: map[string]llb.State{"context": source, "dockerfile": source},
		Exports:        pushTo(request.Target),
	}
}

func secrets(token secret.String, name string) map[string][]byte {
	if token.IsZero() {
		return map[string][]byte{}
	}
	return map[string][]byte{name: []byte(token.Expose())}
}

func randomName(prefix string) (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", fmt.Errorf("random secret name: %w", err)
	}
	return prefix + hex.EncodeToString(bytes[:]), nil
}

// registryAuth answers BuildKit's credential requests for the registry it pushes to, and for no
// other host. BuildKit then asks the registry's token endpoint itself.
type registryAuth struct {
	auth.UnimplementedAuthServer
	credentials Credentials
}

// Register serves the credentials on the build's session.
func (a *registryAuth) Register(server *grpc.Server) {
	auth.RegisterAuthServer(server, a)
}

// Credentials answers the push's user name and password for its registry, and nothing for any
// other host.
func (a *registryAuth) Credentials(_ context.Context, request *auth.CredentialsRequest) (*auth.CredentialsResponse, error) {
	if a.credentials.Host == "" || !strings.EqualFold(request.GetHost(), a.credentials.Host) {
		return &auth.CredentialsResponse{}, nil
	}
	return &auth.CredentialsResponse{Username: a.credentials.Username, Secret: a.credentials.Password.Expose()}, nil
}
