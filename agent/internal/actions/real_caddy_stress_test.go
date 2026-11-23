//go:build integration

package actions

import (
	"context"
	"os"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Temporary: many switches under heavy load, to classify the failures the switch test saw once.
func TestRealCaddyStressSwitches(t *testing.T) {
	socket, address := os.Getenv("SHIPKEEP_IT_CADDY_ADMIN"), os.Getenv("SHIPKEEP_IT_CADDY_ADDRESS")
	if socket == "" || address == "" || os.Getenv("SHIPKEEP_IT_STRESS") == "" {
		t.Skip("stress only on demand")
	}
	router, err := caddy.New(socket)
	if err != nil {
		t.Fatal(err)
	}
	agent := newRealAgent(t, nil)
	for kind, handler := range RouteHandlers(router, agent.engine, nil) {
		agent.dispatcher.Handlers[kind] = handler
	}
	const v1, v2 = "sk-it-st-r1-0", "sk-it-st-r2-0"
	agent.forget([]string{v1, v2}, nil)
	t.Cleanup(func() {
		agent.send(&agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: "it-web", DrainTimeout: durationpb.New(0)}}}, time.Minute)
	})
	agent.prepare()
	for name, version := range map[string]string{v1: "v1", v2: "v2"} {
		id := agent.must("create "+version, itCreate(whoamiSpec(name, version)), time.Minute).GetResult().GetContainerId()
		agent.must("start "+version, itStart(id), time.Minute)
		agent.must("health "+version, itHealth(id), 2*time.Minute)
	}
	agent.must("route to v1", route(v1, 0), time.Minute)
	time.Sleep(2 * time.Second)
	traffic := &load{address: address}
	ctx, stop := context.WithCancel(context.Background())
	clients := traffic.run(ctx, 32)
	for i := range 40 {
		target := v2
		if i%2 == 1 {
			target = v1
		}
		agent.must("switch", route(target, 500*time.Millisecond), time.Minute)
		time.Sleep(300 * time.Millisecond)
	}
	stop()
	clients.Wait()
	traffic.mu.Lock()
	defer traffic.mu.Unlock()
	t.Logf("%d of %d failed", traffic.failures.Load(), traffic.total.Load())
	for _, e := range traffic.errors {
		t.Log(e)
	}
}
