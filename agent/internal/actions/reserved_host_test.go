package actions

import (
	"context"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// No action can route the control plane's name to an application (ADR 0021), not even through a
// wildcard, nor remove the control plane's own route, which is outside the action prefix.
func TestRoutesCannotTakeTheControlPlanesName(t *testing.T) {
	const cp = "shipkeep.example.com"
	for name, hosts := range map[string][]string{
		"exact name":             {cp},
		"among other names":      {"api.example.com", cp},
		"wildcard of its parent": {"*.example.com"},
		"wildcard among others":  {"api.example.com", "*.example.com"},
	} {
		router := &fakeRouter{routes: map[string]caddy.Route{}}
		route := validRoute("172.18.0.5:8080")
		route.Hosts = hosts
		d := &Dispatcher{Journal: open(t), Handlers: RouteHandlers(router, router.containers, func(context.Context, time.Duration) error { return nil }, cp), Epoch: func() uint64 { return 3 }}
		req := upsert(route)
		req.ActionId, req.IdempotencyKey, req.LeaseEpoch = testID, "route", 3
		req.DeadlineUnixMs = time.Now().Add(time.Minute).UnixMilli()
		out := &recorder{}
		d.Handle(context.Background(), req, out.send)
		update := out.last(t)
		if update.GetState() != agentv1.OperationState_OPERATION_STATE_FAILED || update.GetError() != errInvalid || len(router.routes) != 0 {
			t.Errorf("%s: route accepted: %v", name, update)
		}
	}
	// Names it does not cover still route.
	for _, hosts := range [][]string{{"api.example.com"}, {"*.shipkeep.example.com"}, {"shipkeep.example.com.evil.test"}, {"*.other.example.com"}} {
		router := &fakeRouter{routes: map[string]caddy.Route{}}
		route := validRoute("172.18.0.5:8080")
		route.Hosts = hosts
		d := &Dispatcher{Journal: open(t), Handlers: RouteHandlers(router, router.containers, func(context.Context, time.Duration) error { return nil }, cp), Epoch: func() uint64 { return 3 }}
		req := upsert(route)
		req.ActionId, req.IdempotencyKey, req.LeaseEpoch = testID, "route", 3
		req.DeadlineUnixMs = time.Now().Add(time.Minute).UnixMilli()
		out := &recorder{}
		d.Handle(context.Background(), req, out.send)
		if !succeeded(out.last(t)) {
			t.Errorf("%v refused", hosts)
		}
	}
	// The control plane's route id cannot be named by an action: its id is outside the prefix.
	remove := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: caddy.ControlPlaneRouteID}}}
	router := &fakeRouter{routes: map[string]caddy.Route{caddy.ControlPlaneRouteID: caddy.ControlPlaneRoute(cp, "127.0.0.1:8080")}}
	var slept []time.Duration
	routeRequest(t, router, &slept, remove)
	if _, kept := router.routes[caddy.ControlPlaneRouteID]; !kept {
		t.Fatal("an action removed the control plane's route")
	}
}

func TestCovers(t *testing.T) {
	for _, c := range []struct {
		host, name string
		want       bool
	}{
		{"shipkeep.example.com", "shipkeep.example.com", true},
		{"*.example.com", "shipkeep.example.com", true},
		{"*.example.com", "a.b.example.com", false},
		{"*.example.com", "example.com", false},
		{"*.b.example.com", "a.b.example.com", true},
		{"api.example.com", "shipkeep.example.com", false},
		{"*.com", "shipkeep.example.com", false},
	} {
		if got := covers(c.host, c.name); got != c.want {
			t.Errorf("covers(%q, %q) = %v", c.host, c.name, got)
		}
	}
}
