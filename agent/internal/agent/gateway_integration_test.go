package agent_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/agent"
	"github.com/shipkeepdev/shipkeep/agent/internal/config"
	"github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	"github.com/shipkeepdev/shipkeep/agent/internal/gateway"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/shipkeepdev/shipkeep/lib/secret"
)

type logBuffer struct {
	mu   sync.Mutex
	text strings.Builder
}

func (b *logBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.text.Write(data)
}
func (b *logBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.text.String() }

// Started by pnpm test:integration with a live NestJS gateway and PostgreSQL, never a fake server.
func TestControlPlaneLifecycle(t *testing.T) {
	path := os.Getenv("SHIPKEEP_AGENT_TEST_FILE")
	if path == "" {
		t.Skip("run through pnpm test:integration")
	}
	var fixture struct {
		Address     string
		Fingerprint string
		Token       secret.String
	}
	data, err := os.ReadFile(path) // #nosec G703 -- private fixture path supplied only by the integration harness, never a network request.
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal("invalid integration fixture")
	}
	dir := t.TempDir()
	cfg := config.DevDefault(dir)
	cfg.Dev = false
	cfg.Node.Name = "real-go-agent"
	cfg.ControlPlane.Address = fixture.Address
	cfg.ControlPlane.CAFingerprint = fixture.Fingerprint
	cfg.ControlPlane.JoinTokenFile = filepath.Join(dir, "join-token")
	if err := os.WriteFile(cfg.ControlPlane.JoinTokenFile, []byte(fixture.Token.Expose()), 0o600); err != nil {
		t.Fatal(err)
	}
	logs := &logBuffer{}
	daemon, err := agent.New(cfg, slog.New(slog.NewJSONHandler(logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	stopped := make(chan error, 1)
	go func() { stopped <- daemon.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-stopped:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("daemon did not stop")
		}
	})
	wait := func(ready func() bool) {
		t.Helper()
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for !ready() {
			select {
			case <-ctx.Done():
				t.Fatal("agent lifecycle timed out: " + logs.String())
			case <-ticker.C:
			}
		}
	}
	wait(func() bool { return strings.Contains(logs.String(), "agent connected") })
	first, err := credentials.Load(cfg.Paths.StateDir, fixture.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cfg.ControlPlane.JoinTokenFile); !os.IsNotExist(err) {
		t.Fatal("consumed token file remains")
	}
	if _, err := gateway.Enroll(ctx, fixture.Address, fixture.Fingerprint, false, fixture.Token, &agentv1.NodeFacts{Hostname: "reuse-node"}, "test"); err == nil {
		t.Fatal("reused token accepted")
	}
	if err := os.WriteFile(path+".connected", nil, 0o600); err != nil { // #nosec G703 -- marker beside the harness-owned temporary fixture.
		t.Fatal(err)
	}
	wait(func() bool { return strings.Count(logs.String(), "agent connected") >= 2 })
	after, err := credentials.Load(cfg.Paths.StateDir, fixture.Fingerprint)
	if err != nil || !first.Key.Equal(after.Key) || first.NodeID != after.NodeID {
		t.Fatal("restart changed enrolled identity")
	}
	if err := os.WriteFile(path+".reconnected", nil, 0o600); err != nil { // #nosec G703 -- marker beside the harness-owned temporary fixture.
		t.Fatal(err)
	}
	wait(func() bool { return strings.Contains(logs.String(), "credentials rejected") })
	if strings.Contains(logs.String(), fixture.Token.Expose()) || strings.Contains(logs.String(), first.Key.Expose()) {
		t.Fatal("secret leaked in agent logs")
	}
}
