package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer is a bytes.Buffer safe for a writer goroutine and a reading test.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

const fingerprint = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestRunVersion(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"--version"}, &stdout, &stderr); code != exitOK {
		t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, stderr.String())
	}
	if !strings.HasPrefix(stdout.String(), "shipkeep-agent ") {
		t.Fatalf("stdout = %q, want version line", stdout.String())
	}
}

func TestRunUsageErrors(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"--definitely-not-a-flag"}, {"extra", "positional"}} {
		var stdout, stderr bytes.Buffer
		if code := run(context.Background(), args, &stdout, &stderr); code != exitUsage {
			t.Fatalf("run(%v) exit code = %d, want %d", args, code, exitUsage)
		}
	}
}

func TestRunMissingConfigFile(t *testing.T) {
	t.Parallel()
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"--config", filepath.Join(t.TempDir(), "nope.yaml")}, &stdout, &stderr)
	if code != exitConfig || !strings.Contains(stderr.String(), "nope.yaml") {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr.String())
	}
}

func TestRunValidate(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	good := filepath.Join(dir, "good.yaml")
	bad := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(good, []byte("control_plane:\n  address: cp.example.com:7443\n  ca_fingerprint: "+fingerprint+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bad, []byte("control_plane:\n  address: cp.example.com\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	if code := run(context.Background(), []string{"--config", good, "--validate"}, &stdout, &stderr); code != exitOK {
		t.Fatalf("good config: exit code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "configuration is valid") {
		t.Fatalf("stdout = %q", stdout.String())
	}

	stdout.Reset()
	stderr.Reset()
	if code := run(context.Background(), []string{"--config", bad, "--validate"}, &stdout, &stderr); code != exitConfig {
		t.Fatalf("bad config: exit code = %d", code)
	}
	if !strings.Contains(stderr.String(), "ca_fingerprint") || !strings.Contains(stderr.String(), "host:port") {
		t.Fatalf("stderr = %q, want both problems listed", stderr.String())
	}
}

func TestRunDevModeStartsAndStopsOnCancel(t *testing.T) {
	// Not parallel: --dev uses the working directory.
	dir := t.TempDir()
	t.Chdir(dir)

	ctx, cancel := context.WithCancel(context.Background())
	var stdout, stderr syncBuffer
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"--dev"}, &stdout, &stderr) }()

	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(stderr.String(), "agent started") {
		if time.Now().After(deadline) {
			t.Fatalf("agent did not start: %s", stderr.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case code := <-done:
		if code != exitOK {
			t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not stop after cancellation")
	}
	if !strings.Contains(stderr.String(), "agent stopped") || !strings.Contains(stderr.String(), "development mode") {
		t.Fatalf("stderr = %s", stderr.String())
	}
	if _, err := os.Stat(filepath.Join(dir, devDir, "state")); err != nil {
		t.Fatalf("dev state dir missing: %v", err)
	}
}

func TestRunEgressServesOnLoopbackAndStops(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var stdout, stderr syncBuffer
	done := make(chan int, 1)
	go func() { done <- run(ctx, []string{"egress", "--listen", "127.0.0.1:0"}, &stdout, &stderr) }()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(stderr.String(), "egress proxy listening") {
		if time.Now().After(deadline) {
			t.Fatalf("egress proxy did not start: %s", stderr.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case code := <-done:
		if code != exitOK {
			t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("egress proxy did not stop after cancellation")
	}
}

// The proxy never listens beyond loopback: the daemon is its only client.
func TestRunEgressRefusesAnAddressOffLoopback(t *testing.T) {
	for _, args := range [][]string{
		{"egress", "--listen", "0.0.0.0:7480"},
		{"egress", "--listen", "192.168.1.5:7480"},
		{"egress", "--listen", "localhost:7480"},
		{"egress", "--listen", ":7480"},
		{"egress", "extra"},
	} {
		var stdout, stderr syncBuffer
		if code := run(context.Background(), args, &stdout, &stderr); code != exitUsage {
			t.Errorf("%v: exit %d", args, code)
		}
	}
}

// The guard runs before each start of the agent and never keeps it from starting (ADR 0028).
func TestUpgradeGuardAlwaysLetsTheAgentStart(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	binDir := filepath.Join(dir, "bin")
	for _, path := range []string{stateDir, binDir} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	config := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(config, []byte("control_plane:\n  address: cp.example.com:7443\n  ca_fingerprint: "+fingerprint+"\npaths:\n  state_dir: "+stateDir+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(binDir, "shipkeep-agent")
	for name, body := range map[string]string{binary: "new", binary + ".previous": "old"} {
		if err := os.WriteFile(name, []byte(body), 0o755); err != nil { //nolint:gosec // executable stand-ins
			t.Fatal(err)
		}
	}
	record := `{"from":"0.1.0","to":"0.2.0","binary":"` + binary + `","sha256":"aa","at":"2026-11-23T00:00:00Z","state":"pending","attempts":3}`
	if err := os.WriteFile(filepath.Join(stateDir, "upgrade.json"), []byte(record), 0o600); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	// Over the limit: the previous binary comes back.
	if code := run(context.Background(), []string{"upgrade-guard", "--config", config}, &bytes.Buffer{}, &stderr); code != exitOK {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if data, _ := os.ReadFile(binary); string(data) != "old" {
		t.Fatalf("binary %q after the guard: %s", data, stderr.String())
	}
	// Nothing to do, a broken record, a missing configuration and unexpected arguments: exit 0.
	for _, args := range [][]string{
		{"upgrade-guard", "--config", config},
		{"upgrade-guard", "--config", filepath.Join(dir, "absent.yaml")},
		{"upgrade-guard", "--config", config, "extra"},
	} {
		if code := run(context.Background(), args, &bytes.Buffer{}, &bytes.Buffer{}); code != exitOK {
			t.Errorf("%v: exit %d", args, code)
		}
	}
	if err := os.WriteFile(filepath.Join(stateDir, "upgrade.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := run(context.Background(), []string{"upgrade-guard", "--config", config}, &bytes.Buffer{}, &bytes.Buffer{}); code != exitOK {
		t.Fatalf("a broken record kept the agent from starting: %d", code)
	}
}
