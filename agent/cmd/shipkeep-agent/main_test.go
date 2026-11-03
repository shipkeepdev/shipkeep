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
