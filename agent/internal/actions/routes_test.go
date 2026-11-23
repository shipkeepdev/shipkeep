package actions

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

type fakeRouter struct {
	mu         sync.Mutex
	routes     map[string]caddy.Route
	plain      []string
	server     bool
	containers fakeContainers
	// failUpsert makes UpsertRoute fail, as Caddy refusing the new route would.
	failUpsert bool
}

// fakeContainers answers container inspections for route upstreams (ADR 0017).
type fakeContainers map[string]docker.Container

func (f fakeContainers) Container(_ context.Context, ref string) (docker.Container, error) {
	container, ok := f[ref]
	if !ok {
		return docker.Container{}, errors.New("no such container")
	}
	return container, nil
}

func runningContainer(managed bool, networks map[string]string) docker.Container {
	container := docker.Container{}
	container.Config.Labels = map[string]string{}
	if managed {
		container.Config.Labels[docker.ManagedLabel] = "true"
	}
	container.State.Running = true
	container.NetworkSettings.Networks = map[string]struct {
		IPAddress string `json:"IPAddress"`
	}{}
	for name, address := range networks {
		container.NetworkSettings.Networks[name] = struct {
			IPAddress string `json:"IPAddress"`
		}{IPAddress: address}
	}
	return container
}

func (f *fakeRouter) EnsureServer(context.Context) error { f.server = true; return nil }
func (f *fakeRouter) Route(_ context.Context, id string) (caddy.Route, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	route, ok := f.routes[id]
	return route, ok, nil
}

// ApplyRoute follows the order of the Caddy client: removals, the route, then additions.
func (f *fakeRouter) ApplyRoute(ctx context.Context, route caddy.Route, add, remove []string) error {
	if err := f.SetPlainHosts(ctx, nil, remove); err != nil {
		return err
	}
	f.mu.Lock()
	if f.failUpsert {
		f.mu.Unlock()
		return errors.New("caddy POST: status 400")
	}
	f.routes[route.ID] = route
	f.mu.Unlock()
	return f.SetPlainHosts(ctx, add, nil)
}
func (f *fakeRouter) RemoveRoute(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.routes, id)
	return nil
}
func (f *fakeRouter) SetPlainHosts(_ context.Context, add, remove []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.plain = slices.DeleteFunc(f.plain, func(host string) bool { return slices.Contains(remove, host) })
	for _, host := range add {
		if !slices.Contains(f.plain, host) {
			f.plain = append(f.plain, host)
		}
	}
	return nil
}

func routeRequest(t *testing.T, router *fakeRouter, slept *[]time.Duration, req *agentv1.ActionRequest) *agentv1.ActionUpdate {
	t.Helper()
	sleep := func(_ context.Context, duration time.Duration) error {
		*slept = append(*slept, duration)
		return nil
	}
	d := &Dispatcher{Journal: open(t), Handlers: RouteHandlers(router, router.containers, sleep), Epoch: func() uint64 { return 3 }}
	req.ActionId, req.IdempotencyKey, req.LeaseEpoch = testID, "route", 3
	req.DeadlineUnixMs = time.Now().Add(time.Minute).UnixMilli()
	out := &recorder{}
	d.Handle(context.Background(), req, out.send)
	return out.last(t)
}

func upsert(route *agentv1.Route) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_UpsertRoute{UpsertRoute: &agentv1.UpsertRoute{Route: route}}}
}

func validRoute(upstream string) *agentv1.Route {
	return &agentv1.Route{RouteId: "api-prod", Hosts: []string{"api.acme.example.com"}, Upstreams: []*agentv1.Upstream{{Address: upstream}}, DrainTimeout: durationpb.New(10 * time.Second)}
}

func TestRoutesSwitchThenDrain(t *testing.T) {
	router := &fakeRouter{routes: map[string]caddy.Route{}}
	var slept []time.Duration
	if !succeeded(routeRequest(t, router, &slept, upsert(validRoute("172.18.0.5:8080")))) || !router.server {
		t.Fatal("first route not applied")
	}
	if len(slept) != 0 {
		t.Fatal("a brand new route waited for draining")
	}
	if !succeeded(routeRequest(t, router, &slept, upsert(validRoute("172.18.0.6:8080")))) {
		t.Fatal("route switch failed")
	}
	route := router.routes[caddy.RouteID("api-prod")]
	if route.Handle[0].Upstreams[0].Dial != "172.18.0.6:8080" || len(route.Handle[0].Upstreams) != 1 || !slices.Equal(slept, []time.Duration{10 * time.Second}) {
		t.Fatalf("switch did not replace upstreams then drain: %+v %v", route, slept)
	}
	remove := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: "api-prod"}}}
	if !succeeded(routeRequest(t, router, &slept, remove)) || len(router.routes) != 0 || slept[len(slept)-1] != defaultDrain {
		t.Fatal("route not removed and drained")
	}
}

func TestPlainRoutesSkipAutomaticHTTPS(t *testing.T) {
	router := &fakeRouter{routes: map[string]caddy.Route{}}
	var slept []time.Duration
	route := validRoute("10.8.0.2:3000")
	route.TlsMode = agentv1.TlsMode_TLS_MODE_OFF
	route.Upstreams = append(route.Upstreams, &agentv1.Upstream{Address: "10.8.0.3:3000", Weight: 3})
	if !succeeded(routeRequest(t, router, &slept, upsert(route))) || !slices.Equal(router.plain, []string{"api.acme.example.com"}) {
		t.Fatalf("plain host not skipped: %v", router.plain)
	}
	// TLS off: the route answers plain HTTP, on port 80.
	if match := router.routes[caddy.RouteID("api-prod")].Match; len(match) != 1 || match[0].Protocol != "" {
		t.Fatalf("a route with TLS off is limited to HTTPS: %+v", match)
	}
	policy := router.routes[caddy.RouteID("api-prod")].Handle[0].LoadBalancing
	if policy == nil || policy.SelectionPolicy["policy"] != "weighted_round_robin" {
		t.Fatal("weights not applied")
	}
	route.TlsMode = agentv1.TlsMode_TLS_MODE_AUTO_HTTP
	if !succeeded(routeRequest(t, router, &slept, upsert(route))) || len(router.plain) != 0 {
		t.Fatalf("switching back to HTTPS kept the skip: %v", router.plain)
	}
	if match := router.routes[caddy.RouteID("api-prod")].Match; len(match) != 1 || match[0].Protocol != caddy.HTTPS {
		t.Fatalf("switching back to HTTPS left the route answering plain HTTP: %+v", match)
	}
}

func TestHTTPSRoutesLeavePlainHTTPToTheRedirect(t *testing.T) {
	// Caddy inserts its HTTP-to-HTTPS redirect after the last route that matches a host, on the
	// server that listens on both ports: a route that matched plain HTTP would answer before it.
	for _, mode := range []agentv1.TlsMode{agentv1.TlsMode_TLS_MODE_UNSPECIFIED, agentv1.TlsMode_TLS_MODE_AUTO_HTTP} {
		router := &fakeRouter{routes: map[string]caddy.Route{}}
		var slept []time.Duration
		route := validRoute("172.18.0.5:8080")
		route.TlsMode = mode
		route.Hosts = []string{"api.acme.example.com", "*.preview.acme.example.com"}
		if !succeeded(routeRequest(t, router, &slept, upsert(route))) {
			t.Fatalf("%v: route not applied", mode)
		}
		match := router.routes[caddy.RouteID("api-prod")].Match
		if len(match) != 1 || match[0].Protocol != caddy.HTTPS || !slices.Equal(match[0].Host, route.Hosts) {
			t.Fatalf("%v: route does not answer HTTPS only: %+v", mode, match)
		}
	}
}

func TestRoutesRejectMaliciousInput(t *testing.T) {
	mutations := map[string]func(*agentv1.Route){
		"no hosts":           func(r *agentv1.Route) { r.Hosts = nil },
		"ip host":            func(r *agentv1.Route) { r.Hosts = []string{"10.0.0.1"} },
		"uppercase host":     func(r *agentv1.Route) { r.Hosts = []string{"API.example.com"} },
		"host injection":     func(r *agentv1.Route) { r.Hosts = []string{"a.example.com\"},{\"handler\":\"static_response"} },
		"localhost":          func(r *agentv1.Route) { r.Hosts = []string{"localhost"} },
		"duplicate host":     func(r *agentv1.Route) { r.Hosts = []string{"a.example.com", "a.example.com"} },
		"oversized host":     func(r *agentv1.Route) { r.Hosts = []string{strings.Repeat("a.", 130) + "com"} },
		"public upstream":    func(r *agentv1.Route) { r.Upstreams[0].Address = "8.8.8.8:80" },
		"metadata upstream":  func(r *agentv1.Route) { r.Upstreams[0].Address = "169.254.169.254:80" },
		"loopback upstream":  func(r *agentv1.Route) { r.Upstreams[0].Address = "127.0.0.1:2019" },
		"hostname upstream":  func(r *agentv1.Route) { r.Upstreams[0].Address = "db.internal:5432" },
		"unix upstream":      func(r *agentv1.Route) { r.Upstreams[0].Address = "unix//run/docker.sock" },
		"port zero":          func(r *agentv1.Route) { r.Upstreams[0].Address = "10.0.0.2:0" },
		"weight overflow":    func(r *agentv1.Route) { r.Upstreams[0].Weight = 1000 },
		"dns tls":            func(r *agentv1.Route) { r.TlsMode = agentv1.TlsMode_TLS_MODE_AUTO_DNS },
		"long drain":         func(r *agentv1.Route) { r.DrainTimeout = durationpb.New(time.Hour) },
		"route id injection": func(r *agentv1.Route) { r.RouteId = "../config" },
		"uppercase route id": func(r *agentv1.Route) { r.RouteId = "API" },
		"no upstreams":       func(r *agentv1.Route) { r.Upstreams = nil },
		// A maintenance route answers with the agent's page, so it proxies nowhere (ADR 0025).
		"maintenance with an upstream": func(r *agentv1.Route) { r.Maintenance = true },
		"maintenance with a container": func(r *agentv1.Route) {
			r.Maintenance = true
			r.Upstreams = []*agentv1.Upstream{{Container: "sk-api-1", Port: 8080}}
		},
		"maintenance with an injected host": func(r *agentv1.Route) {
			r.Maintenance, r.Upstreams = true, nil
			r.Hosts = []string{"a.example.com\"},{\"handler\":\"reverse_proxy"}
		},
		"maintenance without hosts": func(r *agentv1.Route) { r.Maintenance, r.Upstreams, r.Hosts = true, nil, nil },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			router := &fakeRouter{routes: map[string]caddy.Route{}}
			var slept []time.Duration
			route := validRoute("172.18.0.5:8080")
			mutate(route)
			if update := routeRequest(t, router, &slept, upsert(route)); update.GetError() != errInvalid || len(router.routes) != 0 {
				t.Fatalf("accepted: %v", update)
			}
		})
	}
}

func TestRoutesResolveLocalContainers(t *testing.T) {
	router := &fakeRouter{routes: map[string]caddy.Route{}, containers: fakeContainers{
		"sk-web-1": runningContainer(true, map[string]string{"bridge": "172.17.0.9", "sk-prod": "172.20.0.4", "sk-aaa": ""}),
		"sk-web-2": runningContainer(true, map[string]string{"sk-prod": "172.20.0.5"}),
	}}
	var slept []time.Duration
	route := validRoute("10.8.0.2:3000")
	route.Upstreams = append(route.Upstreams,
		&agentv1.Upstream{Container: "sk-web-1", Port: 8080},
		&agentv1.Upstream{Container: "sk-web-2", Port: 8080, Weight: 2},
	)
	if update := routeRequest(t, router, &slept, upsert(route)); !succeeded(update) {
		t.Fatalf("container upstreams not applied: %v", update)
	}
	dials := make([]string, 0, 3)
	for _, upstream := range router.routes[caddy.RouteID("api-prod")].Handle[0].Upstreams {
		dials = append(dials, upstream.Dial)
	}
	// The bridge network and networks without an address are skipped; order and weights are kept.
	if !slices.Equal(dials, []string{"10.8.0.2:3000", "172.20.0.4:8080", "172.20.0.5:8080"}) {
		t.Fatalf("unexpected upstreams: %v", dials)
	}
}

func TestRoutesRejectUnsafeContainerUpstreams(t *testing.T) {
	containers := fakeContainers{
		"sk-web":      runningContainer(true, map[string]string{"sk-prod": "172.20.0.4"}),
		"sk-foreign":  runningContainer(false, map[string]string{"sk-prod": "172.20.0.6"}),
		"sk-bridge":   runningContainer(true, map[string]string{"bridge": "172.17.0.2"}),
		"sk-public":   runningContainer(true, map[string]string{"sk-prod": "8.8.8.8"}),
		"sk-loopback": runningContainer(true, map[string]string{"sk-prod": "127.0.0.1"}),
		"sk-twin":     runningContainer(true, map[string]string{"sk-prod": "172.20.0.4"}),
	}
	stopped := runningContainer(true, map[string]string{"sk-prod": "172.20.0.7"})
	stopped.State.Running = false
	containers["sk-stopped"] = stopped
	cases := map[string][]*agentv1.Upstream{
		"address and container":  {{Address: "10.0.0.2:80", Container: "sk-web", Port: 80}},
		"container without port": {{Container: "sk-web"}},
		"port without container": {{Port: 80}},
		"port overflow":          {{Container: "sk-web", Port: 70000}},
		"name injection":         {{Container: "sk-web/../../docker", Port: 80}},
		"container id":           {{Container: strings.Repeat("a", 64), Port: 80}},
		"unprefixed name":        {{Container: "postgres", Port: 5432}},
		"duplicate container":    {{Container: "sk-web", Port: 80}, {Container: "sk-web", Port: 80}},
		"unmanaged container":    {{Container: "sk-foreign", Port: 80}},
		"stopped container":      {{Container: "sk-stopped", Port: 80}},
		"missing container":      {{Container: "sk-missing", Port: 80}},
		"no shipkeep network":    {{Container: "sk-bridge", Port: 80}},
		"public address":         {{Container: "sk-public", Port: 80}},
		"loopback address":       {{Container: "sk-loopback", Port: 80}},
		"same dial twice":        {{Container: "sk-web", Port: 80}, {Container: "sk-twin", Port: 80}},
		"collides with address":  {{Address: "172.20.0.4:80"}, {Container: "sk-web", Port: 80}},
	}
	for name, upstreams := range cases {
		t.Run(name, func(t *testing.T) {
			router := &fakeRouter{routes: map[string]caddy.Route{}, containers: containers}
			var slept []time.Duration
			route := validRoute("172.18.0.5:8080")
			route.Upstreams = upstreams
			if update := routeRequest(t, router, &slept, upsert(route)); succeeded(update) || len(router.routes) != 0 {
				t.Fatalf("accepted: %v", update)
			}
		})
	}
}

// reachable reports whether a host is served at all: a host under automatic HTTPS needs a route
// that matches HTTPS; a host with TLS off has no certificate, so it needs a route that matches plain
// HTTP.
func reachable(router *fakeRouter, host string) bool {
	for _, route := range router.routes {
		for _, match := range route.Match {
			if !slices.Contains(match.Host, host) {
				continue
			}
			if slices.Contains(router.plain, host) {
				return match.Protocol == ""
			}
			return true
		}
	}
	return false
}

func TestAFailedRouteChangeLeavesItsHostsReachable(t *testing.T) {
	for _, change := range []struct {
		name     string
		from, to agentv1.TlsMode
	}{
		{"automatic HTTPS to TLS off", agentv1.TlsMode_TLS_MODE_AUTO_HTTP, agentv1.TlsMode_TLS_MODE_OFF},
		{"TLS off to automatic HTTPS", agentv1.TlsMode_TLS_MODE_OFF, agentv1.TlsMode_TLS_MODE_AUTO_HTTP},
	} {
		router := &fakeRouter{routes: map[string]caddy.Route{}}
		var slept []time.Duration
		route := validRoute("172.18.0.5:8080")
		route.TlsMode = change.from
		if !succeeded(routeRequest(t, router, &slept, upsert(route))) || !reachable(router, "api.acme.example.com") {
			t.Fatalf("%s: first route not applied", change.name)
		}
		router.failUpsert = true
		route.TlsMode = change.to
		if succeeded(routeRequest(t, router, &slept, upsert(route))) {
			t.Fatalf("%s: a refused route reported success", change.name)
		}
		if !reachable(router, "api.acme.example.com") {
			t.Fatalf("%s: the failure left the host unreachable: plain %v, routes %+v", change.name, router.plain, router.routes)
		}
	}
}

// In maintenance, Caddy answers the route's hosts with the agent's own page while the replicas
// keep running; leaving it proxies to them again (ADR 0025).
func TestMaintenanceRoutesServeTheAgentsPage(t *testing.T) {
	router := &fakeRouter{routes: map[string]caddy.Route{}}
	var slept []time.Duration
	if !succeeded(routeRequest(t, router, &slept, upsert(validRoute("172.18.0.5:8080")))) {
		t.Fatal("route not applied")
	}
	maintenance := validRoute("")
	maintenance.Upstreams, maintenance.Maintenance = nil, true
	if !succeeded(routeRequest(t, router, &slept, upsert(maintenance))) {
		t.Fatal("maintenance route refused")
	}
	route := router.routes[caddy.RouteID("api-prod")]
	if len(route.Handle) != 1 || !reflect.DeepEqual(route.Handle[0], caddy.MaintenanceHandler()) {
		t.Fatalf("maintenance does not serve the agent's page: %+v", route.Handle)
	}
	if handler := route.Handle[0]; handler.Handler != "static_response" || handler.StatusCode != 503 || len(handler.Upstreams) != 0 {
		t.Fatalf("maintenance still proxies, or does not answer 503: %+v", handler)
	}
	// Same hosts, still HTTPS only; the requests the replicas were serving drain first.
	if match := route.Match; len(match) != 1 || match[0].Protocol != caddy.HTTPS || !slices.Equal(match[0].Host, maintenance.Hosts) {
		t.Fatalf("maintenance changed what the route matches: %+v", match)
	}
	if !slices.Equal(slept, []time.Duration{10 * time.Second}) {
		t.Fatalf("switching to maintenance did not drain: %v", slept)
	}
	if !succeeded(routeRequest(t, router, &slept, upsert(validRoute("172.18.0.5:8080")))) {
		t.Fatal("leaving maintenance refused")
	}
	if handler := router.routes[caddy.RouteID("api-prod")].Handle[0]; handler.Handler != "reverse_proxy" || handler.Upstreams[0].Dial != "172.18.0.5:8080" || handler.Body != "" {
		t.Fatalf("leaving maintenance does not proxy again: %+v", handler)
	}
	// With TLS off, the page answers plain HTTP, as the route did.
	maintenance.TlsMode = agentv1.TlsMode_TLS_MODE_OFF
	if !succeeded(routeRequest(t, router, &slept, upsert(maintenance))) || !slices.Equal(router.plain, []string{"api.acme.example.com"}) {
		t.Fatalf("maintenance with TLS off not served on plain HTTP: %v", router.plain)
	}
}
