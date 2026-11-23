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
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const itHost = "web.example.test"

// load sends requests through Caddy from several clients until stopped, and counts what came back.
type load struct {
	address  string
	total    atomic.Int64
	failures atomic.Int64
	mu       sync.Mutex
	// names holds the replica that answered each request, in order, and errors the first failures.
	names  []string
	errors []string
}

func (l *load) get(ctx context.Context, client *http.Client) (int, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+l.address+"/", nil)
	if err != nil {
		return 0, "", err
	}
	request.Host = itHost
	response, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	return response.StatusCode, string(body), err
}

func (l *load) run(ctx context.Context, clients int) *sync.WaitGroup {
	var wg sync.WaitGroup
	for range clients {
		wg.Go(func() {
			client := &http.Client{Timeout: 10 * time.Second}
			for ctx.Err() == nil {
				status, body, err := l.get(context.WithoutCancel(ctx), client)
				l.total.Add(1)
				l.mu.Lock()
				if err != nil || status != http.StatusOK {
					l.failures.Add(1)
					if len(l.errors) < 5 {
						l.errors = append(l.errors, strings.TrimSpace(errorText(status, err)))
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
	for kind, handler := range RouteHandlers(router, agent.engine, nil) {
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
