package actions

import (
	"bufio"
	"encoding/base64"
	"os"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/lib/agentproto"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// TestControlPlaneActionsPassAgentValidation plans every action the control plane's deployment
// pipeline sends (vectors written by apps/api agent-steps.spec.ts) with the agent's own handlers.
func TestControlPlaneActionsPassAgentValidation(t *testing.T) {
	file, err := os.Open("testdata/control-plane-actions.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close() //nolint:errcheck // read-only test fixture
	handlers := dockerHandlers(newFakeEngine(), confirmer{}, &fakeProber{}, nil)
	for kind, handler := range RouteHandlers(&fakeRouter{routes: map[string]caddy.Route{}}, fakeContainers{}, nil) {
		handlers[kind] = handler
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	count := 0
	for scanner.Scan() {
		_, encoded, ok := strings.Cut(scanner.Text(), " ")
		if !ok {
			t.Fatalf("malformed vector line %d", count+1)
		}
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		req := &agentv1.ActionRequest{}
		if err := proto.Unmarshal(raw, req); err != nil {
			t.Fatal(err)
		}
		kind := agentproto.ActionKind(req)
		handler, ok := handlers[kind]
		if !ok {
			t.Fatalf("no handler for %s", kind)
		}
		if _, err := handler.Plan(req); err != nil {
			t.Fatalf("agent rejects the control plane's %s: %v", kind, err)
		}
		count++
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if count < 9 { // network, pull, task, create, start, health, route, unroute, stop
		t.Fatalf("expected the full pipeline, got %d actions", count)
	}
}
