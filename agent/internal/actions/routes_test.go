package actions

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/caddy"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

type fakeRouter struct {
	mu     sync.Mutex
	routes map[string]caddy.Route
	plain  []string
	server bool
}

func (f *fakeRouter) EnsureServer(context.Context) error { f.server = true; return nil }
func (f *fakeRouter) Route(_ context.Context, id string) (caddy.Route, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	route, ok := f.routes[id]
	return route, ok, nil
}
func (f *fakeRouter) UpsertRoute(_ context.Context, route caddy.Route) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[route.ID] = route
	return nil
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
	d := &Dispatcher{Journal: open(t), Handlers: RouteHandlers(router, sleep), Epoch: func() uint64 { return 3 }}
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
	policy := router.routes[caddy.RouteID("api-prod")].Handle[0].LoadBalancing
	if policy == nil || policy.SelectionPolicy["policy"] != "weighted_round_robin" {
		t.Fatal("weights not applied")
	}
	route.TlsMode = agentv1.TlsMode_TLS_MODE_AUTO_HTTP
	if !succeeded(routeRequest(t, router, &slept, upsert(route))) || len(router.plain) != 0 {
		t.Fatalf("switching back to HTTPS kept the skip: %v", router.plain)
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
