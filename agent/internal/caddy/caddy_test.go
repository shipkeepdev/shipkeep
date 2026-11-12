package caddy

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeAdmin keeps the server config and routes by id, enough to exercise the client's calls.
type fakeAdmin struct {
	mu       sync.Mutex
	apps     bool
	server   bool
	routes   map[string]json.RawMessage
	requests []string
}

func (f *fakeAdmin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path)
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/config":
		_, _ = w.Write([]byte(`{"admin":{"listen":"unix//run/caddy.sock"}}`))
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps":
		writeExists(w, f.apps)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/config/apps/http"):
		if !f.apps {
			// As Caddy does for a path below a missing parent.
			http.Error(w, `{"error":"invalid traversal path at: config/apps/http"}`, http.StatusBadRequest)
			return
		}
		writeExists(w, f.server && !strings.HasSuffix(r.URL.Path, "automatic_https"))
	case r.Method == http.MethodPut && r.URL.Path == "/config/apps":
		f.apps, f.server = true, true
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/id/"):
		route, ok := f.routes[strings.TrimPrefix(r.URL.Path, "/id/")]
		if !ok {
			http.Error(w, `{"error":"unknown object ID"}`, http.StatusNotFound)
			return
		}
		_, _ = w.Write(route)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/routes"),
		r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/id/"):
		var route Route
		_ = json.Unmarshal(body, &route)
		f.routes[route.ID] = body
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/id/"):
		id := strings.TrimPrefix(r.URL.Path, "/id/")
		if _, ok := f.routes[id]; !ok {
			http.Error(w, "private config detail", http.StatusNotFound)
			return
		}
		delete(f.routes, id)
	case r.Method == http.MethodPut || r.Method == http.MethodPatch:
	default:
		http.Error(w, "private config detail", http.StatusBadRequest)
	}
}

func writeExists(w http.ResponseWriter, exists bool) {
	if exists {
		_, _ = w.Write([]byte(`{}`))
		return
	}
	_, _ = w.Write([]byte(`null`))
}

func admin(t *testing.T) (*Client, *fakeAdmin) {
	t.Helper()
	dir, err := os.MkdirTemp("", "sk-caddy")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "admin.sock")
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", path)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeAdmin{routes: map[string]json.RawMessage{}}
	server := &http.Server{Handler: fake} //nolint:gosec // test server on a private socket
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	return client, fake
}

func TestClientBootstrapsWithoutLoadAndUpsertsById(t *testing.T) {
	client, fake := admin(t)
	ctx := context.Background()
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	route := Route{ID: RouteID("api"), Match: []Match{{Host: []string{"a.example.com"}}}, Handle: []Handler{{Handler: "reverse_proxy", Upstreams: []Upstream{{Dial: "10.0.0.2:80"}}}}, Terminal: true}
	if err := client.UpsertRoute(ctx, route); err != nil {
		t.Fatal(err)
	}
	route.Handle[0].Upstreams[0].Dial = "10.0.0.3:80"
	if err := client.UpsertRoute(ctx, route); err != nil {
		t.Fatal(err)
	}
	stored, ok, err := client.Route(ctx, RouteID("api"))
	if err != nil || !ok || stored.Handle[0].Upstreams[0].Dial != "10.0.0.3:80" {
		t.Fatalf("route not replaced: %+v %v %v", stored, ok, err)
	}
	if err := client.RemoveRoute(ctx, RouteID("api")); err != nil {
		t.Fatal(err)
	}
	if err := client.RemoveRoute(ctx, RouteID("api")); err != nil {
		t.Fatalf("removing a missing route failed: %v", err)
	}
	for _, request := range fake.requests {
		if strings.Contains(request, "/load") {
			t.Fatal("client used /load, which would reset the admin endpoint")
		}
	}
	if !strings.Contains(strings.Join(fake.requests, ","), "PATCH /id/sk-route-api") {
		t.Fatalf("second upsert did not patch by id: %v", fake.requests)
	}
}

func TestClientHidesCaddyErrors(t *testing.T) {
	client, _ := admin(t)
	err := client.do(context.Background(), http.MethodPost, "/unknown", map[string]string{}, nil)
	if err == nil || strings.Contains(err.Error(), "private config detail") {
		t.Fatalf("caddy text leaked: %v", err)
	}
	if _, err := New("relative.sock"); err == nil {
		t.Fatal("accepted a relative socket path")
	}
}
