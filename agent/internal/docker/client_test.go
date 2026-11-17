package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

// fakeDaemon serves a few Engine API endpoints on a Unix socket.
func fakeDaemon(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	dir, err := os.MkdirTemp("", "sk-docker") // short path: Unix socket paths are length-limited
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "docker.sock")
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", path)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler} //nolint:gosec // test server on a private socket
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := New("unix://" + path)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestClientMatchesNetworkNamesExactly(t *testing.T) {
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/"+apiVersion+"/networks" {
			http.NotFound(w, r)
			return
		}
		// The daemon's name filter is a substring match: both names come back.
		_ = json.NewEncoder(w).Encode([]Network{{ID: "1", Name: "sk-app-old"}, {ID: "2", Name: "sk-app", Labels: map[string]string{ManagedLabel: "true"}}})
	})
	network, err := client.NetworkByName(context.Background(), "sk-app")
	if err != nil || network.ID != "2" {
		t.Fatalf("got %v, %v", network, err)
	}
	if _, err := client.NetworkByName(context.Background(), "sk-ap"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("prefix matched: %v", err)
	}
}

func TestClientReportsStatusWithoutDaemonText(t *testing.T) {
	client := fakeDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/volumes/sk-missing"):
			http.NotFound(w, r)
		case strings.HasSuffix(r.URL.Path, "/images/create"):
			if r.URL.Query().Get("fromImage") != "registry.internal/app" || r.URL.Query().Get("tag") != "sha256:abc" || r.Header.Get("X-Registry-Auth") == "" {
				http.Error(w, "bad pull", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte("{\"status\":\"Pulling\"}\n{\"error\":\"private registry detail\"}\n"))
		default:
			http.Error(w, "secret path /var/lib/docker", http.StatusInternalServerError)
		}
	})
	ctx := context.Background()
	if _, err := client.Volume(ctx, "sk-missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing volume: %v", err)
	}
	err := client.CreateVolume(ctx, "sk-data", nil)
	if err == nil || strings.Contains(err.Error(), "/var/lib/docker") {
		t.Fatalf("daemon text leaked: %v", err)
	}
	err = client.PullImage(ctx, "registry.internal/app", "sha256:abc", &Auth{Server: "registry.internal", Username: "u", Password: secret.NewString("p")})
	if err == nil || strings.Contains(err.Error(), "private registry detail") {
		t.Fatalf("pull error not detected or leaked: %v", err)
	}
}

func TestClientRefusesNonUnixHosts(t *testing.T) {
	for _, host := range []string{"tcp://127.0.0.1:2375", "unix://", "unix://relative.sock", "http://docker"} {
		if _, err := New(host); err == nil {
			t.Fatalf("accepted %q", host)
		}
	}
}

// A failed pull is named from a closed list of causes. The daemon's message decides the cause and
// is then dropped: it can hold hosts, paths, tokens or credentials.
func TestPullNamesItsCauseWithoutTheDaemonText(t *testing.T) {
	digest := "sha256:" + strings.Repeat("ab12", 16)
	cases := []struct{ message, cause string }{
		// containerd image store
		{`failed to resolve reference "registry.example.com/acme/app@` + digest + `": pull access denied, repository does not exist or may require authorization: authorization failed: no basic auth credentials`, CauseRegistryDenied},
		{`failed to resolve reference "docker.io/acme/app@` + digest + `": failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://auth.docker.io/token?scope=repository%3Aacme%2Fapp%3Apull&service=registry.docker.io: 401 Unauthorized`, CauseRegistryDenied},
		{`failed to resolve reference "ghcr.io/acme/app@` + digest + `": ghcr.io/acme/app@` + digest + `: not found`, CauseImageNotFound},
		// classic image store
		{`unauthorized: incorrect username or password`, CauseRegistryDenied},
		{`pull access denied for acme/app, repository does not exist or may require 'docker login': denied: requested access to the resource is denied`, CauseRegistryDenied},
		{`manifest for acme/app@` + digest + ` not found: manifest unknown: manifest unknown`, CauseImageNotFound},
		// A digest is hexadecimal: digits such as 401 or 403 in it say nothing about the cause.
		{`manifest for acme/app@sha256:` + strings.Repeat("4014", 16) + ` not found: manifest unknown`, CauseImageNotFound},
		{`Get "https://registry.example.com/v2/": dial tcp: lookup registry.example.com on 127.0.0.53:53: no such host`, CauseRegistryUnreachable},
		{`Get "https://registry.example.com/v2/": dial tcp 203.0.113.5:443: connect: connection refused`, CauseRegistryUnreachable},
		{`Get "https://registry.example.com/v2/": net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)`, CauseRegistryUnreachable},
		{`Get "https://registry.example.com/v2/": tls: failed to verify certificate: x509: certificate signed by unknown authority`, CauseRegistryUntrusted},
		{`failed to register layer: write /var/lib/docker/overlay2/abc/diff/app: no space left on device`, CauseDiskFull},
		// A registry that answers "denied" while its disk is full is still a full disk on the server.
		{`write /var/lib/containerd/io.containerd.content.v1.content/ingest/x: no space left on device: denied`, CauseDiskFull},
		{`something nobody has seen yet, with https://deploy:sk_test_fake_registry_password@registry.example.com/v2/ in it`, ""},
		{strings.Repeat("x", 1<<20), ""},
	}
	leaks := []string{"registry.example.com", "auth.docker.io", "/var/lib", "acme", "sk_test_fake", "sha256", "127.0.0.53", "203.0.113.5", "xxx"}
	for _, inStream := range []bool{true, false} {
		for _, tc := range cases {
			client := fakeDaemon(t, func(w http.ResponseWriter, _ *http.Request) {
				if inStream {
					_, _ = w.Write([]byte("{\"status\":\"Pulling\"}\n"))
					_ = json.NewEncoder(w).Encode(map[string]string{"error": tc.message})
					return
				}
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]string{"message": tc.message})
			})
			err := client.PullImage(context.Background(), "registry.example.com/acme/app", digest, nil)
			var pull *PullError
			if !errors.As(err, &pull) {
				t.Fatalf("stream=%t %.60q: not a pull error: %v", inStream, tc.message, err)
			}
			if pull.Cause() != tc.cause {
				t.Fatalf("stream=%t %.60q: cause %q, want %q", inStream, tc.message, pull.Cause(), tc.cause)
			}
			for _, leak := range leaks {
				if strings.Contains(err.Error(), leak) {
					t.Fatalf("stream=%t %.60q: daemon text leaked into %q", inStream, tc.message, err.Error())
				}
			}
		}
	}
}

// The daemon answers 404 both for a missing image and for one it may not see: without a message
// that says more, it is a missing image.
func TestPullOfAMissingImageWithoutAMessage(t *testing.T) {
	client := fakeDaemon(t, func(w http.ResponseWriter, _ *http.Request) { http.NotFound(w, nil) })
	err := client.PullImage(context.Background(), "acme/app", "sha256:abc", nil)
	var pull *PullError
	if !errors.As(err, &pull) || pull.Cause() != CauseImageNotFound {
		t.Fatalf("got %v", err)
	}
}
