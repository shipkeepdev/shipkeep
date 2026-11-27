// Package buildkit drives the server's rootless BuildKit daemon over its gRPC socket (ADR 0030):
// it fetches a repository at a commit, builds it with BuildKit's Dockerfile frontend and pushes
// the image to the installation's registry. It never runs a process and never touches the Docker
// daemon; requests arrive validated by the BuildImage action.
package buildkit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
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

// Request is one build, as the BuildImage action validated it.
type Request struct {
	// Repository is an HTTPS Git URL, without credentials.
	Repository string
	// Commit is the full commit hash fetched.
	Commit string
	// Token reads the repository; zero for a public one. It reaches BuildKit as a session secret
	// under a name of this build's own, never as a build argument or in a URL.
	Token secret.String
	// Context is the build context's directory in the repository, relative; empty for its root.
	Context string
	// Dockerfile is the Dockerfile's path, relative to Context.
	Dockerfile string
	// Args are the build arguments.
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
}

// Build runs the build and pushes the image, sending each line of its output to line, and answers
// the pushed manifest's digest.
func (c Client) Build(ctx context.Context, request Request, line func(string)) (string, error) {
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
	options := SolveOptions(request, tokenName, headerName)
	options.Session = []session.Attachable{
		secretsprovider.FromMap(secrets(request.Token, tokenName)),
		&registryAuth{credentials: request.Registry},
	}
	progress := make(chan *client.SolveStatus)
	printed := make(chan struct{})
	go func() {
		defer close(printed)
		printer := newPrinter(line)
		for update := range progress {
			printer.update(update)
		}
		printer.flush()
	}()
	response, err := daemon.Solve(ctx, nil, options, progress)
	<-printed
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

// SolveOptions is the build without its session: the repository at the commit, as the context
// and as the Dockerfile's source, BuildKit's Dockerfile frontend, and a push of Target.
func SolveOptions(request Request, tokenName, headerName string) client.SolveOpt {
	gitOptions := []llb.GitOption{
		llb.GitRef(request.Commit),
		llb.AuthTokenSecret(tokenName),
		// The default header secret name is not served: only this build's own names are.
		llb.AuthHeaderSecret(headerName),
	}
	if request.Context != "" {
		gitOptions = append(gitOptions, llb.GitSubDir(request.Context))
	}
	source := llb.Git(request.Repository, "", gitOptions...)
	attrs := map[string]string{"filename": request.Dockerfile}
	for name, value := range request.Args {
		attrs["build-arg:"+name] = value
	}
	return client.SolveOpt{
		Frontend:       "dockerfile.v0",
		FrontendAttrs:  attrs,
		FrontendInputs: map[string]llb.State{"context": source, "dockerfile": source},
		Exports: []client.ExportEntry{{
			Type:  client.ExporterImage,
			Attrs: map[string]string{"name": request.Target, "push": "true"},
		}},
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
