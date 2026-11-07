package agent_test

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/agent"
	"github.com/shipkeepdev/shipkeep/agent/internal/config"
)

// startupBuffer signals only after startup has completed; readers wait for Run to stop.
type startupBuffer struct {
	bytes.Buffer
	started chan struct{}
}

func (b *startupBuffer) Write(data []byte) (int, error) {
	n, err := b.Buffer.Write(data)
	if bytes.Contains(data, []byte("agent started")) {
		close(b.started)
	}
	return n, err
}

func TestNewRejectsInvalidConfig(t *testing.T) {
	t.Parallel()
	cfg := config.Default() // no control plane set
	if _, err := agent.New(cfg, slog.Default()); err == nil {
		t.Fatal("New() accepted an invalid configuration")
	}
}

func TestRunStartsAndStopsCleanly(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	cfg := config.DevDefault(dir)
	buf := startupBuffer{started: make(chan struct{})}
	logger := slog.New(slog.NewJSONHandler(&buf, nil))

	a, err := agent.New(cfg, logger)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()

	// SQLite initialization must finish before testing a running agent shutdown.
	select {
	case <-buf.started:
	case err := <-done:
		t.Fatalf("startup failed: %v", err)
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("agent did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not return after cancellation")
	}

	out := buf.String()
	if !strings.Contains(out, "agent started") || !strings.Contains(out, "agent stopped") {
		t.Fatalf("logs = %s", out)
	}
	for _, sub := range []string{"state", "run"} {
		info, err := os.Stat(filepath.Join(dir, sub))
		if err != nil || !info.IsDir() {
			t.Fatalf("%s directory not created: %v", sub, err)
		}
		if sub == "state" && info.Mode().Perm() != 0o700 {
			t.Fatalf("state dir mode = %o, want 0700", info.Mode().Perm())
		}
	}
}

func TestRunTightensLooseStateDirectory(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	cfg := config.DevDefault(dir)
	if err := os.MkdirAll(cfg.Paths.StateDir, 0o755); err != nil { //nolint:gosec // deliberately loose, the agent must tighten it
		t.Fatal(err)
	}
	a, err := agent.New(cfg, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := a.Run(ctx); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	info, err := os.Stat(cfg.Paths.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("state dir mode = %o, want 0700", info.Mode().Perm())
	}
}

func TestRunFailsWhenStateDirIsAFile(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	cfg := config.DevDefault(dir)
	if err := os.WriteFile(cfg.Paths.StateDir, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	a, err := agent.New(cfg, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Run(context.Background()); err == nil {
		t.Fatal("Run() succeeded with a file in place of the state directory")
	}
}
