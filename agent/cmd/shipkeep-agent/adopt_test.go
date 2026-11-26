package main

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
)

// serveUnix serves handler on a Unix socket at path until the test ends.
func serveUnix(t *testing.T, path string, handler http.Handler) {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", path)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler} //nolint:gosec // test server on a private socket
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
}

// legacyNode is a server as an agent of 0.1.0-alpha.3 left it: Caddy with two routes and no
// record, Docker with the API container at the first route's address and another application's
// container at the second one's.
func legacyNode(t *testing.T) (config, stateDir string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "sk-adopt")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	stateDir = filepath.Join(dir, "state")
	docker := http.NewServeMux()
	docker.HandleFunc("GET /v1.47/containers/json", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"Id":"c1","Names":["/sk-api-1"]},{"Id":"c2","Names":["/sk-web-1"]}]`))
	})
	inspected := map[string]string{
		"c1": `{"Id":"c1","Config":{"Labels":{"sk.managed":"true","shipkeep.application":"api-prod"}},"State":{"Running":true},"NetworkSettings":{"Networks":{"sk-env-a":{"IPAddress":"172.18.0.5"}}}}`,
		"c2": `{"Id":"c2","Config":{"Labels":{"sk.managed":"true","shipkeep.application":"web-prod"}},"State":{"Running":true},"NetworkSettings":{"Networks":{"sk-env-a":{"IPAddress":"172.18.0.6"}}}}`,
	}
	docker.HandleFunc("GET /v1.47/containers/{id}/json", func(w http.ResponseWriter, r *http.Request) {
		body, ok := inspected[r.PathValue("id")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	})
	serveUnix(t, filepath.Join(dir, "docker.sock"), docker)
	caddy := http.NewServeMux()
	caddy.HandleFunc("GET /config/apps/http/servers/shipkeep/routes", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"@id":"sk-route-api-prod","match":[{"host":["api.example.com"]}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"172.18.0.5:8080"}]}],"terminal":true},` +
			`{"@id":"sk-route-blog-prod","match":[{"host":["blog.example.com"]}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"172.18.0.6:8080"}]}],"terminal":true}]`))
	})
	serveUnix(t, filepath.Join(dir, "caddy.sock"), caddy)
	config = filepath.Join(dir, "agent.yaml")
	body := "control_plane:\n  address: cp.example.com:7443\n  ca_fingerprint: " + fingerprint + "\npaths:\n  state_dir: " + stateDir +
		"\ndocker:\n  host: unix://" + filepath.Join(dir, "docker.sock") + "\ncaddy:\n  admin_socket: " + filepath.Join(dir, "caddy.sock") + "\n"
	if err := os.WriteFile(config, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return config, stateDir
}

func TestAdoptRoutesRecordsWhatItCanTieAndNamesTheRest(t *testing.T) {
	config, stateDir := legacyNode(t)
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"adopt-routes", "--config", config}, &stdout, &stderr)
	if code != exitRefused {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
	}
	want := "routes: 0 already followed, 1 adopted, 1 refused\nrefused: application blog-prod (other_application)\n"
	if stdout.String() != want {
		t.Fatalf("stdout = %q, want %q", stdout.String(), want)
	}
	if strings.Contains(stdout.String()+stderr.String(), "172.18.") {
		t.Fatal("an address was printed")
	}
	store, err := journal.Open(context.Background(), stateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	routes, err := store.RecordedRoutes(context.Background())
	if err != nil || len(routes) != 1 || routes[0] != "sk-route-api-prod" {
		t.Fatalf("recorded = %v, %v", routes, err)
	}
	// The agent holds the journal: adoption waits for it to stop rather than race it.
	if code := run(context.Background(), []string{"adopt-routes", "--config", config}, &bytes.Buffer{}, &stderr); code != exitError || !strings.Contains(stderr.String(), "is the agent stopped") {
		t.Fatalf("with the journal held: exit %d, stderr %q", code, stderr.String())
	}
}

func TestAdoptRoutesRefusesBadArguments(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{
		{"adopt-routes", "extra"},
		{"adopt-routes", "--config", ""},
		{"adopt-routes", "--unknown"},
	} {
		if code := run(context.Background(), args, &bytes.Buffer{}, &bytes.Buffer{}); code != exitUsage {
			t.Errorf("%v: exit %d, want %d", args, code, exitUsage)
		}
	}
	if code := run(context.Background(), []string{"adopt-routes", "--config", filepath.Join(t.TempDir(), "absent.yaml")}, &bytes.Buffer{}, &bytes.Buffer{}); code != exitConfig {
		t.Errorf("missing configuration: exit %d, want %d", code, exitConfig)
	}
}
