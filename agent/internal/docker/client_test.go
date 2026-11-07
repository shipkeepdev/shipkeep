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
