//go:build integration

package actions

// Acceptance of M1.5 against a real Caddy (#17): a route serves v1, switches to v2 under constant
// load, and the replaced replica is stopped after draining, with no failed request. The CI job
// "Agent against Docker and Caddy" starts Caddy on the network sk-it, with its admin socket in a
// shared directory, and passes:
//   - SHIPKEEP_IT_CADDY_ADMIN: the admin socket path;
//   - SHIPKEEP_IT_CADDY_ADDRESS: Caddy's address on sk-it, `ip:80`.
// Without them, the test is skipped.

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptrace"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/reconcile"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const itHost = "web.example.test"

// load sends requests through Caddy from several clients until stopped, and counts what came back.
type load struct {
	address  string
	total    atomic.Int64
	failures atomic.Int64
	// idleRaces counts requests sent again after their idle kept-alive connection was closed.
	idleRaces atomic.Int64
	mu        sync.Mutex
	// names holds the replica that answered each request, in order, and errors the first failures.
	names  []string
	errors []string
}

func (l *load) get(ctx context.Context, client *http.Client) (int, string, error) {
	status, body, _, err := l.traced(ctx, client)
	return status, body, err
}

// traced also says whether the request went out on a kept-alive connection that was idle.
func (l *load) traced(ctx context.Context, client *http.Client) (int, string, bool, error) {
	var reusedIdle bool
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
		reusedIdle = info.Reused && info.WasIdle
	}})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+l.address+"/", nil)
	if err != nil {
		return 0, "", false, err
	}
	request.Host = itHost
	response, err := client.Do(request)
	if err != nil {
		return 0, "", reusedIdle, err
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	return response.StatusCode, string(body), reusedIdle, err
}

func (l *load) run(ctx context.Context, clients int) *sync.WaitGroup {
	var wg sync.WaitGroup
	for range clients {
		wg.Go(func() {
			client := &http.Client{Timeout: 10 * time.Second}
			for ctx.Err() == nil {
				status, body, reusedIdle, err := l.traced(context.WithoutCancel(ctx), client)
				// Caddy closes its idle keep-alive connections when its configuration changes, as
				// any server may. A GET sent on one at that instant fails without having been
				// served, and HTTP lets a client send it again on a new connection (RFC 9112,
				// 9.3.1), as browsers do. That is the one failure retried, once; it is counted.
				if err != nil && reusedIdle {
					l.idleRaces.Add(1)
					status, body, reusedIdle, err = l.traced(context.WithoutCancel(ctx), client)
				}
				l.total.Add(1)
				l.mu.Lock()
				if err != nil || status != http.StatusOK {
					l.failures.Add(1)
					if len(l.errors) < 5 {
						l.errors = append(l.errors, fmt.Sprintf("[reused idle connection: %v] %s", reusedIdle, strings.TrimSpace(errorText(status, err))))
					}
				} else {
					l.names = append(l.names, whoamiName(body))
				}
				l.mu.Unlock()
			}
		})
	}
	return &wg
}

func errorText(status int, err error) string {
	if err != nil {
		return err.Error()
	}
	return http.StatusText(status)
}

// whoamiName reads the `Name: v1` line whoami answers with.
func whoamiName(body string) string {
	for line := range strings.SplitSeq(body, "\n") {
		if name, ok := strings.CutPrefix(line, "Name: "); ok {
			return strings.TrimSpace(name)
		}
	}
	return "?"
}

func route(container string, drain time.Duration) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_UpsertRoute{UpsertRoute: &agentv1.UpsertRoute{Route: &agentv1.Route{
		RouteId:      "it-web",
		Hosts:        []string{itHost},
		Upstreams:    []*agentv1.Upstream{{Container: container, Port: 8080}},
		TlsMode:      agentv1.TlsMode_TLS_MODE_OFF,
		DrainTimeout: durationpb.New(drain),
	}}}}
}

func TestRealCaddySwitchesUnderLoadWithoutAFailedRequest(t *testing.T) {
	socket, address := os.Getenv("SHIPKEEP_IT_CADDY_ADMIN"), os.Getenv("SHIPKEEP_IT_CADDY_ADDRESS")
	if socket == "" || address == "" {
		t.Skip("SHIPKEEP_IT_CADDY_ADMIN and SHIPKEEP_IT_CADDY_ADDRESS name the Caddy to test against")
	}
	router, err := caddy.New(socket)
	if err != nil {
		t.Fatal(err)
	}
	agent := newRealAgent(t, nil)
	for kind, handler := range RouteHandlers(router, agent.engine, &RouteBook{Store: agent.store}, nil) {
		agent.dispatcher.Handlers[kind] = handler
	}
	const v1, v2 = "sk-it-web-r1-0", "sk-it-web-r2-0"
	agent.forget([]string{v1, v2}, nil)
	t.Cleanup(func() {
		agent.send(&agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: "it-web", DrainTimeout: durationpb.New(0)}}}, time.Minute)
	})
	agent.prepare()
	ids := map[string]string{}
	for name, version := range map[string]string{v1: "v1", v2: "v2"} {
		ids[name] = agent.must("create "+version, itCreate(whoamiSpec(name, version)), time.Minute).GetResult().GetContainerId()
		agent.must("start "+version, itStart(ids[name]), time.Minute)
		agent.must("health "+version, itHealth(ids[name]), 2*time.Minute)
	}

	// v1 serves.
	agent.must("route to v1", route(v1, 0), time.Minute)
	traffic := &load{address: address}
	client := &http.Client{Timeout: 10 * time.Second}
	deadline := time.Now().Add(30 * time.Second)
	for {
		status, body, err := traffic.get(context.Background(), client)
		if err == nil && status == http.StatusOK && whoamiName(body) == "v1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("v1 never answered through Caddy: %d %v", status, err)
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Constant load while the route switches to v2, drains, and v1 is stopped and removed, as the
	// deployment pipeline does it.
	ctx, stopLoad := context.WithCancel(context.Background())
	clients := traffic.run(ctx, 8)
	time.Sleep(2 * time.Second)
	agent.must("switch to v2", route(v2, 3*time.Second), time.Minute)
	agent.must("stop v1", itStop(ids[v1]), time.Minute)
	agent.must("remove v1", itRemove(ids[v1]), time.Minute)
	time.Sleep(2 * time.Second)
	stopLoad()
	clients.Wait()

	traffic.mu.Lock()
	defer traffic.mu.Unlock()
	if failures := traffic.failures.Load(); failures != 0 {
		t.Fatalf("%d of %d requests failed during the switch, first: %v", failures, traffic.total.Load(), traffic.errors)
	}
	if races := traffic.idleRaces.Load(); races != 0 {
		t.Logf("%d requests were sent again after Caddy closed their idle connection", races)
	}
	if traffic.total.Load() < 100 {
		t.Fatalf("only %d requests: the load was not constant", traffic.total.Load())
	}
	seen := map[string]int{}
	for _, name := range traffic.names {
		seen[name]++
	}
	// Both versions answered, and once v1 is gone only v2 does.
	if seen["v1"] == 0 || seen["v2"] == 0 || traffic.names[len(traffic.names)-1] != "v2" {
		t.Fatalf("answers by version: %v", seen)
	}
	t.Logf("%d requests, none failed: %v", traffic.total.Load(), seen)
}

// Acceptance of M1.6 (#18): with no control plane, a container that crashed is started again by
// the reconciler and its route follows it, even when another container took its old address while
// it was down. While it is down, the route answers 503. Without the route refresh, that route
// would send the traffic to the other one.
func TestRealCaddyFollowsARestartedContainer(t *testing.T) {
	socket, address := os.Getenv("SHIPKEEP_IT_CADDY_ADMIN"), os.Getenv("SHIPKEEP_IT_CADDY_ADDRESS")
	if socket == "" || address == "" {
		t.Skip("SHIPKEEP_IT_CADDY_ADMIN and SHIPKEEP_IT_CADDY_ADDRESS name the Caddy to test against")
	}
	router, err := caddy.New(socket)
	if err != nil {
		t.Fatal(err)
	}
	agent := newRealAgent(t, nil)
	book := &RouteBook{Store: agent.store}
	for kind, handler := range RouteHandlers(router, agent.engine, book, nil) {
		agent.dispatcher.Handlers[kind] = handler
	}
	const a, b, host = "sk-it-moved-a-r1-0", "sk-it-moved-b-r1-0", "moved.example.test"
	agent.forget([]string{a, b}, nil)
	t.Cleanup(func() {
		agent.send(&agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: "it-moved", DrainTimeout: durationpb.New(0)}}}, time.Minute)
	})
	agent.prepare()
	ctx := context.Background()
	answer := func() string {
		t.Helper()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+"/", nil) //nolint:gosec // the CI job names Caddy's address
		if err != nil {
			t.Fatal(err)
		}
		request.Host = host
		response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request) //nolint:gosec // the CI job names Caddy's address
		if err != nil {
			return "error: " + err.Error()
		}
		defer response.Body.Close() //nolint:errcheck // read-only body
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if response.StatusCode == http.StatusServiceUnavailable {
			return "unavailable"
		}
		return whoamiName(string(body))
	}
	idA := agent.must("create a", itCreate(whoamiSpec(a, "a")), time.Minute).GetResult().GetContainerId()
	agent.must("start a", itStart(idA), time.Minute)
	agent.must("health a", itHealth(idA), 2*time.Minute)
	agent.must("route to a", &agentv1.ActionRequest{Action: &agentv1.ActionRequest_UpsertRoute{UpsertRoute: &agentv1.UpsertRoute{Route: &agentv1.Route{
		RouteId: "it-moved", Hosts: []string{host}, TlsMode: agentv1.TlsMode_TLS_MODE_OFF,
		Upstreams: []*agentv1.Upstream{{Container: a, Port: 8080}},
	}}}}, time.Minute)
	if got := answer(); got != "a" {
		t.Fatalf("route to a answered %q", got)
	}
	before, err := containerDial(ctx, agent.engine, a, 8080)
	if err != nil {
		t.Fatal(err)
	}

	// a crashes: Docker stops it, the agent is not told; its intent is still to run.
	if err := agent.engine.StopContainer(ctx, idA, 0); err != nil {
		t.Fatal(err)
	}
	idB := agent.must("create b", itCreate(whoamiSpec(b, "b")), time.Minute).GetResult().GetContainerId()
	agent.must("start b", itStart(idB), time.Minute)
	agent.must("health b", itHealth(idB), 2*time.Minute)
	taken, err := containerDial(ctx, agent.engine, b, 8080)
	if err != nil {
		t.Fatal(err)
	}
	if taken == before {
		// The hazard itself: a's route now reaches b.
		if got := answer(); got != "b" {
			t.Fatalf("expected the stale route to reach b, got %q", got)
		}
	} else {
		t.Logf("b got %s, not a's old %s: the route cannot reach it, the test still checks a comes back", taken, before)
	}

	// While a is down, its route sends nothing to the address b may now hold: it answers 503.
	refresher := RouteRefresher{Router: router, Containers: agent.engine, Book: book}
	if err := refresher.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if got := answer(); got != "unavailable" {
		t.Fatalf("with a stopped, the route answered %q, want 503", got)
	}

	// One reconciliation pass, as the agent runs every 30 s without a control plane.
	reconciler := reconcile.Reconciler{
		Engine: agent.engine, State: agent.store, Logger: slog.New(slog.DiscardHandler),
		Routes: refresher,
	}
	if err := reconciler.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := containerDial(ctx, agent.engine, a, 8080)
	if err != nil {
		t.Fatalf("a was not started again: %v", err)
	}
	// The pass starts a's process and moves the route; whoami takes a moment to listen.
	deadline := time.Now().Add(30 * time.Second)
	got := answer()
	for got != "a" && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
		got = answer()
	}
	if got != "a" {
		t.Fatalf("after reconciliation the route answered %q, want a (a moved from %s to %s)", got, before, after)
	}
}

// #485: a deployment that moves an application to a new hostname fails while switching, and the
// control plane restores the previous route. The route keeps its id (the application's), so the
// restore is an UpsertRoute of that id with the previous release's hostnames and replica. Against a
// real Caddy, the old hostname must reach the old replica again, and the new hostname must reach
// nothing: no matcher of the failed switch may stay behind.
func TestRealCaddyRestoresThePreviousHostnamesAfterAFailedSwitch(t *testing.T) {
	socket, address := os.Getenv("SHIPKEEP_IT_CADDY_ADMIN"), os.Getenv("SHIPKEEP_IT_CADDY_ADDRESS")
	if socket == "" || address == "" {
		t.Skip("SHIPKEEP_IT_CADDY_ADMIN and SHIPKEEP_IT_CADDY_ADDRESS name the Caddy to test against")
	}
	router, err := caddy.New(socket)
	if err != nil {
		t.Fatal(err)
	}
	agent := newRealAgent(t, nil)
	for kind, handler := range RouteHandlers(router, agent.engine, &RouteBook{Store: agent.store}, nil) {
		agent.dispatcher.Handlers[kind] = handler
	}
	const (
		routeID          = "it-restore"
		previous, failed = "sk-it-restore-r1-0", "sk-it-restore-r2-0"
		oldHost, newHost = "old.example.test", "new.example.test"
	)
	agent.forget([]string{previous, failed}, nil)
	t.Cleanup(func() {
		agent.send(&agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: routeID, DrainTimeout: durationpb.New(0)}}}, time.Minute)
	})
	agent.prepare()
	ids := map[string]string{}
	for name, version := range map[string]string{previous: "r1", failed: "r2"} {
		ids[name] = agent.must("create "+version, itCreate(whoamiSpec(name, version)), time.Minute).GetResult().GetContainerId()
		agent.must("start "+version, itStart(ids[name]), time.Minute)
		agent.must("health "+version, itHealth(ids[name]), 2*time.Minute)
	}
	upsert := func(host, container string) *agentv1.ActionRequest {
		return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_UpsertRoute{UpsertRoute: &agentv1.UpsertRoute{Route: &agentv1.Route{
			RouteId:   routeID,
			Hosts:     []string{host},
			Upstreams: []*agentv1.Upstream{{Container: container, Port: 8080}},
			TlsMode:   agentv1.TlsMode_TLS_MODE_OFF,
		}}}}
	}
	// Which replica a hostname reaches: its whoami name, or "none" when no route matches it. Caddy
	// answers a host no route matches with an empty 200. A matcher left behind answers otherwise,
	// for instance with its upstream's 502, which must never count as unmatched.
	reaches := func(host string) string {
		t.Helper()
		request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+address+"/", nil) //nolint:gosec // the CI job names Caddy's address
		if err != nil {
			t.Fatal(err)
		}
		request.Host = host
		response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request) //nolint:gosec // the CI job names Caddy's address
		if err != nil {
			return "error: " + err.Error()
		}
		defer response.Body.Close() //nolint:errcheck // read-only body
		body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if err != nil {
			return "error: " + err.Error()
		}
		if name := whoamiName(string(body)); name != "?" {
			return name
		}
		if response.StatusCode == http.StatusOK && len(body) == 0 {
			return "none"
		}
		return fmt.Sprintf("status %d, %d bytes", response.StatusCode, len(body))
	}
	eventually := func(host, want string) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		got := reaches(host)
		for got != want && time.Now().Before(deadline) {
			time.Sleep(200 * time.Millisecond)
			got = reaches(host)
		}
		if got != want {
			t.Fatalf("%s reaches %q, want %q", host, got, want)
		}
	}

	// Release 1 serves the old hostname.
	agent.must("route r1", upsert(oldHost, previous), time.Minute)
	eventually(oldHost, "r1")
	eventually(newHost, "none")

	// Release 2's switch reaches this node: the route now matches the new hostname only.
	agent.must("switch to r2", upsert(newHost, failed), time.Minute)
	eventually(newHost, "r2")
	eventually(oldHost, "none")

	// The deployment fails on another node; recovery restores release 1's route here.
	agent.must("restore r1", upsert(oldHost, previous), time.Minute)
	eventually(oldHost, "r1")
	eventually(newHost, "none")
	// And the old replica is not reachable through the new hostname either.
	if got := reaches(newHost); got == "r1" {
		t.Fatalf("the new hostname reaches the previous release after the restore")
	}
}
