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
	mu     sync.Mutex
	apps   bool
	server bool
	routes map[string]json.RawMessage
	// order lists route ids as Caddy keeps them; ids set directly in routes come after, sorted.
	order    []string
	skip     []string
	requests []string
	// gate, when set, holds the request "METHOD path" named gated until it is closed; reached is
	// closed when that request arrives.
	gated         string
	gate, reached chan struct{}
	// failRoutes makes Caddy refuse every route write.
	failRoutes bool
}

func (f *fakeAdmin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	gated := f.gate != nil && r.Method+" "+r.URL.Path == f.gated
	gate, reached := f.gate, f.reached
	f.mu.Unlock()
	if gated {
		close(reached)
		<-gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+r.URL.Path)
	body, _ := io.ReadAll(r.Body)
	routeWrite := (r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/routes")) ||
		(r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/id/")) ||
		(r.Method == http.MethodPatch && r.URL.Path == "/config/apps/http/servers/"+Server+"/routes")
	switch {
	case routeWrite && f.failRoutes:
		http.Error(w, "private config detail", http.StatusBadRequest)
	case (r.Method == http.MethodPut || r.Method == http.MethodPatch) && r.URL.Path == "/config/apps/http/servers/"+Server+"/automatic_https":
		var value automaticHTTPS
		_ = json.Unmarshal(body, &value)
		f.skip = value.Skip
		if f.skip == nil {
			f.skip = []string{}
		}
	case r.Method == http.MethodGet && r.URL.Path == "/config":
		_, _ = w.Write([]byte(`{"admin":{"listen":"unix//run/caddy.sock"}}`))
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps":
		writeExists(w, f.apps)
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps/http/servers/"+Server+"/routes" && f.server:
		ids := f.ordered()
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
	case r.Method == http.MethodPatch && r.URL.Path == "/config/apps/http/servers/"+Server+"/routes" && f.server:
		// Caddy replaces the whole list at once.
		var list []json.RawMessage
		_ = json.Unmarshal(body, &list)
		f.routes, f.order = map[string]json.RawMessage{}, []string{}
		for _, raw := range list {
			var route Route
			_ = json.Unmarshal(raw, &route)
			f.routes[route.ID] = raw
			f.order = append(f.order, route.ID)
		}
	case r.Method == http.MethodPut && r.URL.Path == "/config/apps/http/servers/"+Server+"/routes/0" && f.server:
		// Caddy inserts before the index.
		var route Route
		_ = json.Unmarshal(body, &route)
		f.order = append([]string{route.ID}, slices.DeleteFunc(f.ordered(), func(id string) bool { return id == route.ID })...)
		f.routes[route.ID] = body
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/routes"),
		r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/id/"):
		var route Route
		_ = json.Unmarshal(body, &route)
		if _, known := f.routes[route.ID]; !known {
			f.order = append(f.ordered(), route.ID)
		}
		f.routes[route.ID] = body
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/id/"):
		id := strings.TrimPrefix(r.URL.Path, "/id/")
		if _, ok := f.routes[id]; !ok {
			http.Error(w, "private config detail", http.StatusNotFound)
			return
		}
		delete(f.routes, id)
		f.order = slices.DeleteFunc(f.ordered(), func(other string) bool { return other == id })
	case r.Method == http.MethodPut || r.Method == http.MethodPatch:
	default:
		http.Error(w, "private config detail", http.StatusBadRequest)
	}
}

// ordered returns the route ids in Caddy's order: those written through the API first, then any a
// test placed directly in routes, sorted.
func (f *fakeAdmin) ordered() []string {
	ids := slices.DeleteFunc(slices.Clone(f.order), func(id string) bool { _, ok := f.routes[id]; return !ok })
	for _, id := range slices.Sorted(maps.Keys(f.routes)) {
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids
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

// hold makes the fake hold the request "METHOD path" until the returned release runs, and
// returns a channel closed when that request arrives. Release runs at cleanup too, before the
// server's Close, so that a failed test never leaves a handler waiting.
func hold(t *testing.T, fake *fakeAdmin, request string) (<-chan struct{}, func()) {
	t.Helper()
	fake.mu.Lock()
	fake.gated, fake.gate, fake.reached = request, make(chan struct{}), make(chan struct{})
	gate, reached := fake.gate, fake.reached
	fake.mu.Unlock()
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	return reached, release
}

// within waits for a result, at most five seconds.
func within(t *testing.T, results <-chan error, what string) error {
	t.Helper()
	select {
	case err := <-results:
		return err
	case <-time.After(5 * time.Second):
		t.Fatalf("%s did not finish", what)
		return nil
	}
}

func TestSecuringOldRoutesWaitsForNoUpsert(t *testing.T) {
	// The securing reads a route and patches its match: an upsert of the same route in between
	// would be overwritten with the old hosts.
	client, fake := admin(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	fake.mu.Lock()
	fake.apps, fake.server = true, true
	fake.routes[RouteID("old")] = json.RawMessage(`{"@id":"sk-route-old","match":[{"host":["old.example.com"]}],"handle":[],"terminal":true}`)
	fake.mu.Unlock()
	reached, release := hold(t, fake, "GET /config/apps/http/servers/"+Server+"/routes")
	secured := make(chan error, 1)
	go func() { secured <- client.SecureRoutes(ctx) }()
	select {
	case <-reached:
	case err := <-secured:
		t.Fatalf("the securing ended before listing the routes: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the securing never listed the routes")
	}
	upserted := make(chan error, 1)
	go func() {
		upserted <- client.UpsertRoute(ctx, Route{ID: RouteID("old"), Match: []Match{{Host: []string{"new.example.com"}, Protocol: HTTPS}}, Handle: []Handler{}, Terminal: true})
	}()
	select {
	case err := <-upserted:
		t.Fatalf("the upsert ran while the securing held the route: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	release()
	if err := within(t, secured, "the securing"); err != nil {
		t.Fatal(err)
	}
	if err := within(t, upserted, "the upsert"); err != nil {
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

func TestApplyRouteIsOneUnitForTheSecuring(t *testing.T) {
	// Switching a route to TLS off writes the route, then adds its host to the skip list. The
	// securing must not run in between: it would see the host under automatic HTTPS and limit
	// the new route to HTTPS, leaving a skipped host behind an HTTPS-only route.
	client, fake := admin(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	fake.apps, fake.server = true, true
	fake.routes[RouteID("app")] = json.RawMessage(`{"@id":"sk-route-app","match":[{"host":["app.example.com"],"protocol":"https"}],"handle":[],"terminal":true}`)
	secured := make(chan error, 1)
	client.betweenWrites = func() {
		if client.routes.TryLock() {
			client.routes.Unlock()
			t.Error("ApplyRoute released the route lock between its writes")
		}
		// Exactly in the gap: a securing started now must wait for the whole change.
		go func() { secured <- client.SecureRoutes(ctx) }()
		select {
		case err := <-secured:
			t.Errorf("the securing ran in the middle of a route change: %v", err)
			secured <- err
		case <-time.After(100 * time.Millisecond):
		}
	}
	plain := Route{ID: RouteID("app"), Match: []Match{{Host: []string{"app.example.com"}}}, Handle: []Handler{}, Terminal: true}
	if err := client.ApplyRoute(ctx, plain, []string{"app.example.com"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := within(t, secured, "the securing"); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if !slices.Contains(fake.skip, "app.example.com") || strings.Contains(string(fake.routes[RouteID("app")]), "protocol") {
		t.Fatalf("TLS-off route secured anyway: skip %v, route %s", fake.skip, fake.routes[RouteID("app")])
	}
}

func TestAFailedApplyRouteLeavesItsHostsReachable(t *testing.T) {
	ctx := context.Background()
	for _, change := range []struct {
		name        string
		before      string
		skip        []string
		after       Route
		add, remove []string
	}{
		{
			name:   "automatic HTTPS to TLS off",
			before: `{"@id":"sk-route-app","match":[{"host":["app.example.com"],"protocol":"https"}],"handle":[],"terminal":true}`,
			skip:   []string{},
			after:  Route{ID: RouteID("app"), Match: []Match{{Host: []string{"app.example.com"}}}, Handle: []Handler{}, Terminal: true},
			add:    []string{"app.example.com"},
		},
		{
			name:   "TLS off to automatic HTTPS",
			before: `{"@id":"sk-route-app","match":[{"host":["app.example.com"]}],"handle":[],"terminal":true}`,
			skip:   []string{"app.example.com"},
			after:  Route{ID: RouteID("app"), Match: []Match{{Host: []string{"app.example.com"}, Protocol: HTTPS}}, Handle: []Handler{}, Terminal: true},
			remove: []string{"app.example.com"},
		},
	} {
		client, fake := admin(t)
		fake.apps, fake.server, fake.skip = true, true, change.skip
		fake.routes[RouteID("app")] = json.RawMessage(change.before)
		fake.failRoutes = true
		if err := client.ApplyRoute(ctx, change.after, change.add, change.remove); err == nil {
			t.Fatalf("%s: a refused route reported success", change.name)
		}
		// The old route stays; a host under automatic HTTPS needs nothing more, a skipped host has
		// no certificate and needs a route that answers plain HTTP.
		var stored Route
		if err := json.Unmarshal(fake.routes[RouteID("app")], &stored); err != nil {
			t.Fatal(err)
		}
		if slices.Contains(fake.skip, "app.example.com") && stored.Match[0].Protocol != "" {
			t.Fatalf("%s: skipped host behind an HTTPS-only route: skip %v, route %s", change.name, fake.skip, fake.routes[RouteID("app")])
		}
	}
}

func TestTLSHostsListsHTTPSNamesOnly(t *testing.T) {
	client, _ := admin(t)
	ctx := context.Background()
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	for id, match := range map[string]Match{
		"b":     {Host: []string{"b.example.com", "a.example.com"}, Protocol: HTTPS},
		"plain": {Host: []string{"plain.example.com"}},
		"wild":  {Host: []string{"*.example.com"}, Protocol: HTTPS},
		"dup":   {Host: []string{"a.example.com"}, Protocol: HTTPS},
	} {
		route := Route{ID: RouteID(id), Match: []Match{match}, Handle: []Handler{{Handler: "reverse_proxy", Upstreams: []Upstream{{Dial: "10.0.0.2:80"}}}}, Terminal: true}
		if err := client.UpsertRoute(ctx, route); err != nil {
			t.Fatal(err)
		}
	}
	hosts, err := client.TLSHosts(ctx)
	if err != nil || !slices.Equal(hosts, []string{"a.example.com", "b.example.com"}) {
		t.Fatalf("hosts = %v, %v", hosts, err)
	}
}
