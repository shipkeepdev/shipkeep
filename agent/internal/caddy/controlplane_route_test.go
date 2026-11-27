package caddy

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

func firstRoute(t *testing.T, fake *fakeAdmin) Route {
	t.Helper()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	ids := fake.ordered()
	if len(ids) == 0 {
		t.Fatal("no route")
	}
	var route Route
	if err := json.Unmarshal(fake.routes[ids[0]], &route); err != nil {
		t.Fatal(err)
	}
	return route
}

// The control plane's route goes first, so that no application route can win over it, and stays
// out of every action's reach (ADR 0021).
func TestControlPlaneRouteIsFirstAndRepairedOnlyWhenNeeded(t *testing.T) {
	client, fake := admin(t)
	ctx := context.Background()
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	app := Route{ID: RouteID("app"), Match: []Match{{Host: []string{"*.example.com"}, Protocol: HTTPS}}, Handle: []Handler{{Handler: "reverse_proxy", Upstreams: []Upstream{{Dial: "10.0.0.2:80"}}}}, Terminal: true}
	if err := client.UpsertRoute(ctx, app); err != nil {
		t.Fatal(err)
	}
	want := ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080", "127.0.0.1:5000")
	for _, route := range want {
		if strings.HasPrefix(route.ID, idPrefix) {
			t.Fatal("the control plane's routes must be outside the prefix actions use")
		}
	}
	changed, err := client.EnsureControlPlaneRoutes(ctx, want)
	if err != nil || !changed {
		t.Fatalf("first apply: changed=%v err=%v", changed, err)
	}
	// First, the registry's API refuses what is not a token it may parse (#543): only its paths,
	// over HTTPS, answered by Caddy itself.
	if got := firstRoute(t, fake); got.ID != ControlPlaneRegistryRefusedRouteID || got.Match[0].Protocol != HTTPS ||
		!slices.Equal(got.Match[0].Path, []string{"/v2", "/v2/*"}) || !got.Match[0].bounded() ||
		len(got.Match[0].Not) != 1 || got.Match[0].Not[0].VarsRegexp[authorizationHeader].Pattern != RegistryAuthorization ||
		got.Handle[0].Handler != "static_response" || got.Handle[0].StatusCode != 401 || len(got.Handle[0].Upstreams) != 0 {
		t.Fatalf("first route = %+v", got)
	}
	// Then the registry's API (ADR 0030): only its paths, over HTTPS, to the registry's port.
	var registry Route
	fake.mu.Lock()
	_ = json.Unmarshal(fake.routes[ControlPlaneRegistryRouteID], &registry)
	fake.mu.Unlock()
	if registry.Match[0].Protocol != HTTPS || !slices.Equal(registry.Match[0].Path, []string{"/v2", "/v2/*"}) ||
		!registry.Match[0].bounded() || registry.Handle[0].Upstreams[0].Dial != "127.0.0.1:5000" {
		t.Fatalf("registry route = %+v", registry)
	}
	// Then the rest of the name to the control plane, then its redirect on plain HTTP, before the
	// application's wildcard.
	fake.mu.Lock()
	order := fake.ordered()
	var api, redirect Route
	_ = json.Unmarshal(fake.routes[ControlPlaneRouteID], &api)
	_ = json.Unmarshal(fake.routes[ControlPlaneRedirectRouteID], &redirect)
	fake.mu.Unlock()
	if len(order) != 5 || order[1] != ControlPlaneRegistryRouteID || order[2] != ControlPlaneRouteID || order[3] != ControlPlaneRedirectRouteID || order[4] != RouteID("app") {
		t.Fatalf("route order = %v", order)
	}
	if api.Match[0].Path != nil || api.Match[0].Protocol != HTTPS || api.Handle[0].Upstreams[0].Dial != "127.0.0.1:8080" {
		t.Fatalf("control plane route = %+v", api)
	}
	if redirect.Match[0].Protocol != "http" || redirect.Handle[0].Handler != "static_response" || redirect.Handle[0].StatusCode != 308 ||
		redirect.Handle[0].Headers["Location"][0] != "https://{http.request.host}{http.request.uri}" {
		t.Fatalf("redirect = %+v", redirect)
	}
	// Nothing to do when Caddy holds exactly that.
	writes := len(fake.requests)
	if changed, err := client.EnsureControlPlaneRoutes(ctx, want); err != nil || changed {
		t.Fatalf("idempotent apply: changed=%v err=%v", changed, err)
	}
	for _, request := range fake.requests[writes:] {
		if !strings.HasPrefix(request, "GET ") {
			t.Fatalf("an unchanged route was written: %s", request)
		}
	}
	// A changed upstream, or a route moved behind another, is put back in first place.
	fake.mu.Lock()
	fake.order = slices.DeleteFunc(fake.ordered(), func(id string) bool { return id == ControlPlaneRouteID })
	fake.order = append(fake.order, ControlPlaneRouteID)
	fake.mu.Unlock()
	if changed, err := client.EnsureControlPlaneRoutes(ctx, want); err != nil || !changed {
		t.Fatalf("repair: changed=%v err=%v", changed, err)
	}
	if got := firstRoute(t, fake); got.ID != ControlPlaneRegistryRefusedRouteID {
		t.Fatalf("not first after repair: %s", got.ID)
	}
	fake.mu.Lock()
	count := 0
	for _, id := range fake.ordered() {
		if id == ControlPlaneRouteID {
			count++
		}
	}
	fake.mu.Unlock()
	if count != 1 {
		t.Fatalf("%d copies of the control plane's route", count)
	}
}

// Caddy lost its configuration: the server and the route come back.
func TestControlPlaneRouteSurvivesALostConfiguration(t *testing.T) {
	// A fresh Caddy: no apps at all, as after a restart that lost its saved configuration.
	client, fake := admin(t)
	want := ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080", "127.0.0.1:5000")
	if _, err := client.EnsureControlPlaneRoutes(context.Background(), want); err != nil {
		t.Fatal(err)
	}
	if got := firstRoute(t, fake); got.ID != ControlPlaneRegistryRefusedRouteID {
		t.Fatalf("route not restored: %+v", got)
	}
}

// The control plane's name is never served without TLS, even if Caddy's list says so.
func TestControlPlaneRouteLeavesTheHostsWithoutTLS(t *testing.T) {
	client, fake := admin(t)
	ctx := context.Background()
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	fake.skip = []string{"plain.example.com", "shipkeep.example.com"}
	if _, err := client.EnsureControlPlaneRoutes(ctx, ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080", "127.0.0.1:5000")); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fake.skip, []string{"plain.example.com"}) {
		t.Fatalf("hosts without TLS = %v", fake.skip)
	}
}

// A repair of the control plane's route waits for a route change in progress: between the write of
// a route with TLS off and the addition of its host to the hosts without TLS, securing old routes
// would make it answer HTTPS only (#378 review).
func TestControlPlaneRouteWaitsForARouteChangeInProgress(t *testing.T) {
	client, fake := admin(t)
	ctx := context.Background()
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	plain := Route{ID: RouteID("plain"), Match: []Match{{Host: []string{"plain.example.com"}}}, Handle: []Handler{{Handler: "reverse_proxy", Upstreams: []Upstream{{Dial: "10.0.0.2:80"}}}}, Terminal: true}
	repaired := make(chan error, 1)
	requests := func() []string {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		return slices.Clone(fake.requests)
	}
	// Polls until seen holds, or fails after a bound: a regression must not hang the test.
	waitFor := func(seen func([]string) bool) bool {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if seen(requests()) {
				return true
			}
			time.Sleep(time.Millisecond)
		}
		return false
	}
	client.betweenWrites = func() {
		before := len(requests())
		go func() {
			_, err := client.EnsureControlPlaneRoutes(ctx, ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080", "127.0.0.1:5000"))
			repaired <- err
		}()
		// The repair is running once Caddy got its first request, which comes before the lock.
		if !waitFor(func(r []string) bool { return len(r) > before }) {
			t.Error("the repair never started")
			return
		}
		// Under the lock, the repair reads the routes. It must not before the change ends.
		routes := "GET /config/apps/http/servers/" + Server + "/routes"
		if waitFor(func(r []string) bool { return slices.Contains(r[before:], routes) }) {
			t.Error("the repair read the routes in the middle of a route change")
		}
	}
	if err := client.ApplyRoute(ctx, plain, []string{"plain.example.com"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := <-repaired; err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	var stored Route
	if err := json.Unmarshal(fake.routes[RouteID("plain")], &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Match[0].Protocol != "" || !slices.Contains(fake.skip, "plain.example.com") {
		t.Fatalf("the plain route was secured mid-change: %+v, skip %v", stored.Match, fake.skip)
	}
}

// The repair is one write that replaces the list: Caddy never runs a configuration where the fixed
// routes are missing and an application wildcard answers for the control plane's name. The other
// routes keep their order and the fields this client does not model.
func TestControlPlaneRouteRepairIsOneWrite(t *testing.T) {
	client, fake := admin(t)
	ctx := context.Background()
	if err := client.EnsureServer(ctx); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.routes[RouteID("a")] = json.RawMessage(`{"@id":"sk-route-a","match":[{"host":["*.example.com"],"header_regexp":{"Host":{"pattern":"^[^:]+(:443|:80)?$"}},"protocol":"https"}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"10.0.0.2:80"}],"flush_interval":-1}],"terminal":true}`)
	fake.routes[RouteID("b")] = json.RawMessage(`{"@id":"sk-route-b","match":[{"host":["b.example.com"],"header_regexp":{"Host":{"pattern":"^[^:]+(:443|:80)?$"}},"protocol":"https"}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"10.0.0.3:80"}]}],"terminal":true}`)
	fake.order = []string{RouteID("b"), RouteID("a")}
	writes := len(fake.requests)
	fake.mu.Unlock()
	if changed, err := client.EnsureControlPlaneRoutes(ctx, ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080", "127.0.0.1:5000")); err != nil || !changed {
		t.Fatalf("apply: changed=%v err=%v", changed, err)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	routeWrites := []string{}
	for _, request := range fake.requests[writes:] {
		if !strings.HasPrefix(request, "GET ") && !strings.HasSuffix(request, "/automatic_https") {
			routeWrites = append(routeWrites, request)
		}
	}
	if !slices.Equal(routeWrites, []string{"PATCH /config/apps/http/servers/" + Server + "/routes"}) {
		t.Fatalf("route writes = %v", routeWrites)
	}
	if order := fake.ordered(); !slices.Equal(order, []string{ControlPlaneRegistryRefusedRouteID, ControlPlaneRegistryRouteID, ControlPlaneRouteID, ControlPlaneRedirectRouteID, RouteID("b"), RouteID("a")}) {
		t.Fatalf("route order = %v", order)
	}
	if !strings.Contains(string(fake.routes[RouteID("a")]), `"flush_interval":-1`) {
		t.Fatalf("a field the client does not model was lost: %s", fake.routes[RouteID("a")])
	}
}

// What reaches the registry (#543): nothing, or one compact bearer JWS of Shipkeep's size. A token
// in JSON form, an oversized header that could carry a large JWK, two Authorization headers,
// another scheme: refused by Caddy before the registry parses them.
func TestTheRegistryReceivesOnlyBoundedBearerTokens(t *testing.T) {
	allowed := regexp.MustCompile(RegistryAuthorization)
	segment := func(n int) string { return strings.Repeat("A", n) }
	// The size of a token the control plane signs: a header of about 110, claims of about 470.
	ours := "Bearer " + segment(110) + "." + segment(470) + "." + segment(86)
	for _, value := range []string{"", ours, "Bearer " + segment(512) + "." + segment(1000) + "." + segment(512)} {
		if !allowed.MatchString(value) {
			t.Fatalf("refused: %.60s", value)
		}
	}
	for name, value := range map[string]string{
		"oversized header": "Bearer " + segment(513) + "." + segment(470) + "." + segment(86),
		"oversized claims": "Bearer " + segment(110) + "." + segment(1001) + "." + segment(86),
		"JSON form":        `Bearer {"protected":"x","header":{"jwk":{"kty":"RSA"}},"payload":"x","signature":"x"}`,
		"two headers":      ours + "," + ours,
		"basic":            "Basic dXNlcjpwYXNz",
		"two parts":        "Bearer " + segment(110) + "." + segment(470),
		"padding":          "Bearer " + segment(110) + "=." + segment(470) + "." + segment(86),
		"line break":       ours + "\n",
	} {
		if allowed.MatchString(value) {
			t.Fatalf("%s allowed", name)
		}
	}
}

// The control plane's own Caddy, on a machine of its own, refuses exactly the same.
func TestTheComposeCaddyfileRefusesTheSameTokens(t *testing.T) {
	caddyfile, err := os.ReadFile("../../../deploy/control-plane/Caddyfile")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(caddyfile), "not vars_regexp "+authorizationHeader+" `"+RegistryAuthorization+"`") {
		t.Fatal("deploy/control-plane/Caddyfile does not refuse what the agent's route refuses")
	}
}
