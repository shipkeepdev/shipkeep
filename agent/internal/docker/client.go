// Package docker is a minimal, typed client for the Docker Engine API over the local Unix socket.
//
// It exposes only the calls the closed action list needs (CLAUDE.md rules 1 and 2): no exec, no
// build, no arbitrary endpoint. Request bodies are typed structs, names are validated by callers
// and path-escaped here, and response bodies are bounded.
package docker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

// apiVersion is pinned: newer daemons keep serving it, and behavior never shifts silently.
const apiVersion = "v1.47"

const (
	maxBody      = 1 << 20
	maxPullLines = 100_000
	// ManagedLabel marks every resource the agent created; anything else is never modified.
	ManagedLabel = "sk.managed"
)

// ErrNotFound reports a missing network, image or volume.
var ErrNotFound = errors.New("docker resource not found")

// Causes a failed pull can be given. The list is closed: what the agent reports about a failed
// pull names one of them, or nothing (SPEC 3.4).
const (
	// CauseRegistryDenied: the registry refused the pull. The image is private, the credentials
	// are wrong, or the repository does not exist (registries answer the same for all three).
	CauseRegistryDenied = "registry_denied"
	// CauseImageNotFound: the registry has no image with this name and digest.
	CauseImageNotFound = "image_not_found"
	// CauseRegistryUnreachable: no answer from the registry (name, route, timeout).
	CauseRegistryUnreachable = "registry_unreachable"
	// CauseRegistryUntrusted: the server does not trust the registry's certificate.
	CauseRegistryUntrusted = "registry_untrusted"
	// CauseDiskFull: the server has no room left for the image.
	CauseDiskFull = "disk_full"
)

// maxDaemonMessage bounds how much of a daemon message is read to find a cause.
const maxDaemonMessage = 16 * 1024

// PullError is a pull the daemon refused or could not finish. It carries a cause from the closed
// list above, or none, and never the daemon's message.
type PullError struct{ cause string }

func (e *PullError) Error() string {
	if e.cause == "" {
		return "docker pull failed"
	}
	return "docker pull failed: " + e.cause
}

// Cause is one of the Cause constants, or empty when the agent cannot name the failure.
func (e *PullError) Cause() string { return e.cause }

// pullCause reads the daemon's message about a failed pull and names its cause. Only the name
// leaves this function: the message can hold hosts, paths, tokens or credentials, and is dropped.
// The order matters. A full disk and an untrusted certificate are named before the network
// failures whose words their messages also contain. A network failure is named before a refusal:
// Docker reports a token service it cannot reach as "failed to authorize", and nothing was
// refused. A refusal is named before a missing image, for registries that say both.
func pullCause(message string) string {
	if len(message) > maxDaemonMessage {
		message = message[:maxDaemonMessage]
	}
	text := strings.ToLower(message)
	holds := func(parts ...string) bool {
		for _, part := range parts {
			if strings.Contains(text, part) {
				return true
			}
		}
		return false
	}
	switch {
	case holds("no space left on device"):
		return CauseDiskFull
	case holds("x509:", "failed to verify certificate", "certificate signed by unknown authority", "certificate has expired", "certificate is not valid"):
		return CauseRegistryUntrusted
	case holds("no such host", "connection refused", "connection reset", "i/o timeout", "timeout exceeded", "deadline exceeded", "network is unreachable", "no route to host", "temporary failure in name resolution", "server misbehaving", "tls handshake timeout", "unexpected eof"):
		return CauseRegistryUnreachable
	case holds("unauthorized", "access denied", "denied:", "authentication required", "authorization fail", "failed to authorize", "forbidden", "no basic auth credentials"):
		return CauseRegistryDenied
	case holds("manifest unknown", "name unknown", "not found", "no such image"):
		return CauseImageNotFound
	}
	return ""
}

// Client talks to one local Docker daemon.
type Client struct {
	http *http.Client
	// long has no response-header timeout, for calls that answer only when a container exits.
	long *http.Client
}

// New returns a client for a `unix:///path` host. Other schemes are refused (see config).
func New(host string) (*Client, error) {
	path, ok := strings.CutPrefix(host, "unix://")
	if !ok || path == "" || !strings.HasPrefix(path, "/") {
		return nil, errors.New("docker host must be a unix:// socket path")
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", path)
		},
		MaxIdleConns:          4,
		IdleConnTimeout:       30 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	waiting := transport.Clone()
	waiting.ResponseHeaderTimeout = 0
	return &Client{http: &http.Client{Transport: transport}, long: &http.Client{Transport: waiting}}, nil
}

// Network is the subset of a network the agent relies on.
type Network struct {
	ID     string            `json:"Id"`
	Name   string            `json:"Name"`
	Labels map[string]string `json:"Labels"`
}

// Volume is the subset of a volume the agent relies on.
type Volume struct {
	Name   string            `json:"Name"`
	Labels map[string]string `json:"Labels"`
}

// Image is the subset of an image the agent relies on.
type Image struct {
	ID          string   `json:"Id"`
	RepoDigests []string `json:"RepoDigests"`
}

// Auth is registry authentication for one pull; the password never leaves this process except
// in the X-Registry-Auth header sent to the local daemon.
type Auth struct {
	Server   string
	Username string
	Password secret.String
}

// NetworkByName returns the network whose name is exactly name. The Engine's inspect endpoint
// also matches id prefixes, so the agent lists by name and compares exactly.
func (c *Client) NetworkByName(ctx context.Context, name string) (Network, error) {
	filters, err := json.Marshal(map[string][]string{"name": {name}})
	if err != nil {
		return Network{}, fmt.Errorf("encode network filter: %w", err)
	}
	var networks []Network
	if err := c.do(ctx, http.MethodGet, "/networks?filters="+url.QueryEscape(string(filters)), nil, &networks); err != nil {
		return Network{}, err
	}
	for _, network := range networks {
		if network.Name == name {
			return network, nil
		}
	}
	return Network{}, ErrNotFound
}

// CreateNetwork creates a bridge network carrying the managed label and labels.
func (c *Client) CreateNetwork(ctx context.Context, name string, internal bool, labels map[string]string) (string, error) {
	body := map[string]any{"Name": name, "Driver": "bridge", "Internal": internal, "Labels": labels, "CheckDuplicate": true}
	var created struct {
		ID string `json:"Id"`
	}
	if err := c.do(ctx, http.MethodPost, "/networks/create", body, &created); err != nil {
		return "", err
	}
	return created.ID, nil
}

// Volume returns the volume named exactly name.
func (c *Client) Volume(ctx context.Context, name string) (Volume, error) {
	var volume Volume
	if err := c.do(ctx, http.MethodGet, "/volumes/"+url.PathEscape(name), nil, &volume); err != nil {
		return Volume{}, err
	}
	if volume.Name != name {
		return Volume{}, ErrNotFound
	}
	return volume, nil
}

// CreateVolume creates a local volume carrying labels.
func (c *Client) CreateVolume(ctx context.Context, name string, labels map[string]string) error {
	body := map[string]any{"Name": name, "Driver": "local", "Labels": labels}
	return c.do(ctx, http.MethodPost, "/volumes/create", body, &Volume{})
}

// RemoveVolume removes the volume named name. It fails if a container still uses it.
func (c *Client) RemoveVolume(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/volumes/"+url.PathEscape(name), nil, nil)
}

// Image inspects a local image by reference.
func (c *Client) Image(ctx context.Context, ref string) (Image, error) {
	var image Image
	if err := c.do(ctx, http.MethodGet, "/images/"+url.PathEscape(ref)+"/json", nil, &image); err != nil {
		return Image{}, err
	}
	return image, nil
}

// PullImage pulls repository@digest. The daemon streams JSON progress; an error object anywhere in
// the stream, or an error answer, fails the pull with a *PullError: a cause from a closed list,
// never the daemon's text.
func (c *Client) PullImage(ctx context.Context, repository, digest string, auth *Auth) error {
	query := url.Values{"fromImage": {repository}, "tag": {digest}}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker/"+apiVersion+"/images/create?"+query.Encode(), nil)
	if err != nil {
		return fmt.Errorf("build pull request: %w", err)
	}
	if auth != nil {
		header, err := json.Marshal(map[string]string{"username": auth.Username, "password": auth.Password.Expose(), "serveraddress": auth.Server})
		if err != nil {
			return fmt.Errorf("encode registry auth: %w", err)
		}
		request.Header.Set("X-Registry-Auth", base64.URLEncoding.EncodeToString(header))
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("docker pull: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	if response.StatusCode/100 != 2 {
		var problem struct {
			Message string `json:"message"`
		}
		// A body that is too long or not JSON simply names no cause.
		body, _ := io.ReadAll(io.LimitReader(response.Body, maxDaemonMessage))
		_ = json.Unmarshal(body, &problem)
		cause := pullCause(problem.Message)
		// The daemon answers 404 for an image the registry does not have, and says nothing more.
		if cause == "" && response.StatusCode == http.StatusNotFound {
			cause = CauseImageNotFound
		}
		return &PullError{cause: cause}
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 64*1024)
	for lines := 0; scanner.Scan(); lines++ {
		if lines >= maxPullLines {
			return errors.New("docker pull: progress stream too long")
		}
		var event struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Error != "" {
			return &PullError{cause: pullCause(event.Error)}
		}
	}
	if err := scanner.Err(); err != nil {
		// A line longer than the buffer is a daemon message too long to read a cause from.
		if errors.Is(err, bufio.ErrTooLong) {
			return &PullError{}
		}
		return fmt.Errorf("docker pull stream: %w", err)
	}
	return nil
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	return c.request(ctx, c.http, method, path, body, out)
}

func (c *Client) request(ctx context.Context, client *http.Client, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode docker request: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://docker/"+apiVersion+path, reader)
	if err != nil {
		return fmt.Errorf("build docker request: %w", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("docker %s: %w", method, err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if err != nil {
		return fmt.Errorf("read docker response: %w", err)
	}
	if len(data) > maxBody {
		return errors.New("docker response too large")
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case response.StatusCode == http.StatusNotModified:
		// Start of a running or stop of a stopped container: already in the wanted state.
		return nil
	case response.StatusCode/100 != 2:
		// The daemon's message can contain paths or registry details: report the status only.
		return fmt.Errorf("docker %s: status %d", method, response.StatusCode)
	case out == nil || len(data) == 0:
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode docker response: %w", err)
	}
	return nil
}

// DockerVersion returns the daemon's version string.
func (c *Client) DockerVersion(ctx context.Context) (string, error) {
	var version struct {
		Version string `json:"Version"`
	}
	if err := c.do(ctx, http.MethodGet, "/version", nil, &version); err != nil {
		return "", err
	}
	return version.Version, nil
}
