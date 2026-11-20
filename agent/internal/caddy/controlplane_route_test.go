package caddy

import (
	"context"
	"encoding/json"
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
	want := ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080")
	for _, route := range want {
		if strings.HasPrefix(route.ID, idPrefix) {
			t.Fatal("the control plane's routes must be outside the prefix actions use")
		}
	}
	changed, err := client.EnsureControlPlaneRoutes(ctx, want)
	if err != nil || !changed {
		t.Fatalf("first apply: changed=%v err=%v", changed, err)
	}
	if got := firstRoute(t, fake); got.ID != ControlPlaneRouteID || got.Match[0].Protocol != HTTPS || got.Handle[0].Upstreams[0].Dial != "127.0.0.1:8080" {
		t.Fatalf("first route = %+v", got)
	}
	// Then the redirect of that name on plain HTTP, before the application's wildcard.
	fake.mu.Lock()
	order := fake.ordered()
	var redirect Route
	_ = json.Unmarshal(fake.routes[ControlPlaneRedirectRouteID], &redirect)
	fake.mu.Unlock()
	if len(order) != 3 || order[1] != ControlPlaneRedirectRouteID || order[2] != RouteID("app") {
		t.Fatalf("route order = %v", order)
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
	if got := firstRoute(t, fake); got.ID != ControlPlaneRouteID {
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
	want := ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080")
	if _, err := client.EnsureControlPlaneRoutes(context.Background(), want); err != nil {
		t.Fatal(err)
	}
	if got := firstRoute(t, fake); got.ID != ControlPlaneRouteID {
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
	if _, err := client.EnsureControlPlaneRoutes(ctx, ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080")); err != nil {
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
			_, err := client.EnsureControlPlaneRoutes(ctx, ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080"))
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
