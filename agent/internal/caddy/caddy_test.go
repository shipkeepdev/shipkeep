package caddy

import (
	"context"
	"encoding/json"
	"io"
	"maps"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAdmin keeps the server config and routes by id, enough to exercise the client's calls.
type fakeAdmin struct {
	mu       sync.Mutex
	apps     bool
	server   bool
	routes   map[string]json.RawMessage
	skip     []string
	requests []string
	// gate, when set, holds the read of the route list until it is closed; listed is closed when
	// that read arrives.
	gate, listed chan struct{}
}

func (f *fakeAdmin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Path == "/config/apps/http/servers/"+Server+"/routes" && f.gate != nil {
		close(f.listed)
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path)
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/config":
		_, _ = w.Write([]byte(`{"admin":{"listen":"unix//run/caddy.sock"}}`))
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps":
		writeExists(w, f.apps)
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps/http/servers/"+Server+"/routes" && f.server:
		ids := slices.Sorted(maps.Keys(f.routes))
		list := make([]json.RawMessage, 0, len(ids))
		for _, id := range ids {
			list = append(list, f.routes[id])
		}
		_ = json.NewEncoder(w).Encode(list)
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps/http/servers/"+Server+"/automatic_https" && f.skip != nil:
		_ = json.NewEncoder(w).Encode(map[string][]string{"skip": f.skip})
	case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/id/") && strings.HasSuffix(r.URL.Path, "/match"):
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/id/"), "/match")
		var route map[string]json.RawMessage
		if err := json.Unmarshal(f.routes[id], &route); err != nil {
			http.Error(w, "unknown object ID", http.StatusNotFound)
			return
		}
		route["match"] = body
		f.routes[id], _ = json.Marshal(route)
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

func TestClientKeepsABadRequestAnErrorOutsideBootstrap(t *testing.T) {
	client, _ := admin(t)
	ctx := context.Background()
	// The server does not exist yet: reading below it is Caddy's 400, which must not pass for
	// "nothing to change" anywhere but in EnsureServer.
	if err := client.SetPlainHosts(ctx, nil, []string{"a.example.com"}); err == nil {
		t.Fatal("a 400 from Caddy was read as an absent value")
	}
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureServerSecuresRoutesOlderAgentsWrote(t *testing.T) {
	client, fake := admin(t)
	ctx := context.Background()
	fake.apps, fake.server = true, true
	fake.skip = []string{"plain.example.com"}
	// Routes as agents up to 0.1.0-alpha.3 stored them, a TLS-off route, a route already secured,
	// and a route that is not Shipkeep's.
	fake.routes[RouteID("old")] = json.RawMessage(`{"@id":"sk-route-old","match":[{"host":["a.example.com","*.b.example.com"]}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"10.0.0.2:80"}],"health_checks":{"active":{"uri":"/"}}}],"terminal":true}`)
	fake.routes[RouteID("plain")] = json.RawMessage(`{"@id":"sk-route-plain","match":[{"host":["plain.example.com"]}],"handle":[],"terminal":true}`)
	fake.routes[RouteID("new")] = json.RawMessage(`{"@id":"sk-route-new","match":[{"host":["c.example.com"],"protocol":"https"}],"handle":[],"terminal":true}`)
	fake.routes["control-plane"] = json.RawMessage(`{"@id":"control-plane","match":[{"host":["d.example.com"]}],"handle":[],"terminal":true}`)
	before := map[string]string{}
	for id, route := range fake.routes {
		before[id] = string(route)
	}
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	var old struct {
		Match  []Match           `json:"match"`
		Handle []json.RawMessage `json:"handle"`
	}
	if err := json.Unmarshal(fake.routes[RouteID("old")], &old); err != nil {
		t.Fatal(err)
	}
	if len(old.Match) != 1 || old.Match[0].Protocol != HTTPS || !slices.Equal(old.Match[0].Host, []string{"a.example.com", "*.b.example.com"}) {
		t.Fatalf("old route not limited to HTTPS: %+v", old.Match)
	}
	// Only the match changed: fields the agent does not model are kept.
	if len(old.Handle) != 1 || !strings.Contains(string(old.Handle[0]), "health_checks") {
		t.Fatalf("securing the route rewrote its handler: %s", fake.routes[RouteID("old")])
	}
	for _, id := range []string{RouteID("plain"), RouteID("new"), "control-plane"} {
		if string(fake.routes[id]) != before[id] {
			t.Fatalf("route %s changed: %s", id, fake.routes[id])
		}
	}
	// A second pass changes nothing.
	fake.requests = nil
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	for _, request := range fake.requests {
		if strings.HasPrefix(request, "PATCH") || strings.HasPrefix(request, "PUT") {
			t.Fatalf("second pass wrote to Caddy: %v", fake.requests)
		}
	}
}

func TestSecureRoutesCreatesNothingWithoutTheServer(t *testing.T) {
	client, fake := admin(t)
	if err := client.SecureRoutes(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, request := range fake.requests {
		if !strings.HasPrefix(request, "GET") {
			t.Fatalf("SecureRoutes wrote to Caddy without a Shipkeep server: %v", fake.requests)
		}
	}
	fake.apps, fake.server = true, true
	fake.routes[RouteID("old")] = json.RawMessage(`{"@id":"sk-route-old","match":[{"host":["a.example.com"]}],"handle":[],"terminal":true}`)
	if err := client.SecureRoutes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(fake.routes[RouteID("old")]), `"protocol":"https"`) {
		t.Fatalf("SecureRoutes did not secure an old route: %s", fake.routes[RouteID("old")])
	}
}

func TestSecuringOldRoutesWaitsForNoUpsert(t *testing.T) {
	// The securing reads a route and patches its match: an upsert of the same route in between
	// would be overwritten with the old hosts.
	client, fake := admin(t)
	ctx := context.Background()
	fake.mu.Lock()
	fake.apps, fake.server = true, true
	fake.routes[RouteID("old")] = json.RawMessage(`{"@id":"sk-route-old","match":[{"host":["old.example.com"]}],"handle":[],"terminal":true}`)
	fake.gate, fake.listed = make(chan struct{}), make(chan struct{})
	fake.mu.Unlock()
	// Registered after admin(t), so it runs before the server's Close: a failed check must not
	// leave the handler waiting on the gate, and Close waiting on the handler.
	var release sync.Once
	openGate := func() { release.Do(func() { close(fake.gate) }) }
	t.Cleanup(openGate)
	secured := make(chan error, 1)
	go func() { secured <- client.SecureRoutes(ctx) }()
	<-fake.listed
	upserted := make(chan error, 1)
	go func() {
		upserted <- client.UpsertRoute(ctx, Route{ID: RouteID("old"), Match: []Match{{Host: []string{"new.example.com"}, Protocol: HTTPS}}, Handle: []Handler{}, Terminal: true})
	}()
	select {
	case err := <-upserted:
		t.Fatalf("the upsert ran while the securing held the route: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	openGate()
	if err := <-secured; err != nil {
		t.Fatal(err)
	}
	if err := <-upserted; err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	var stored Route
	if err := json.Unmarshal(fake.routes[RouteID("old")], &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored.Match) != 1 || !slices.Equal(stored.Match[0].Host, []string{"new.example.com"}) || stored.Match[0].Protocol != HTTPS {
		t.Fatalf("the upsert was lost: %s", fake.routes[RouteID("old")])
	}
}
