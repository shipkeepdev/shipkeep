//go:build integration

package logship

import (
	"context"
	"io"
	"log/slog"
	"maps"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const realBusybox = "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"

// ackingStream acknowledges every batch at once, as a control plane whose store kept it.
type ackingStream struct {
	mu      sync.Mutex
	entries []*agentv1.LogEntry
	acks    chan uint64
	ctx     context.Context
}

func (s *ackingStream) Send(frame *agentv1.ShipLogsRequest) error {
	if batch := frame.GetBatch(); batch != nil {
		s.mu.Lock()
		s.entries = append(s.entries, batch.GetEntries()...)
		s.mu.Unlock()
		s.acks <- batch.GetSeq()
	}
	return nil
}

func (s *ackingStream) Recv() (*agentv1.ShipLogsResponse, error) {
	select {
	case seq := <-s.acks:
		return &agentv1.ShipLogsResponse{Frame: &agentv1.ShipLogsResponse_Ack{Ack: &agentv1.LogAck{Seq: seq}}}, nil
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}

// realRun is one managed container under a real shipper, on the real engine.
type realRun struct {
	store   *journal.Store
	entries []*agentv1.LogEntry
}

// shipReal runs a disposable container with env and labels, starts the shipper after wait (its
// earlier output is backlog), stops it once the container's want lines were sent and their cursor
// kept, and returns what it sent of that container.
func shipReal(t *testing.T, name string, script string, env []string, labels map[string]string, wait time.Duration, want int) realRun {
	t.Helper()
	socket := os.Getenv("SHIPKEEP_IT_DOCKER")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	client, err := docker.New("unix://" + socket)
	if err != nil {
		t.Fatal(err)
	}
	store, err := journal.Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	repository, digest, _ := strings.Cut(realBusybox, "@")
	if err := client.PullImage(ctx, repository, digest, nil); err != nil {
		t.Fatal(err)
	}
	all := map[string]string{docker.ManagedLabel: "true", NameLabel: name}
	maps.Copy(all, labels)
	// The script is the test's own fixture, run inside the disposable container.
	id, err := client.CreateContainer(ctx, "", docker.ContainerConfig{
		Image: realBusybox, Cmd: []string{"sh", "-c", script}, Env: env, Labels: all,
		HostConfig: docker.HostConfig{NetworkMode: "none", SecurityOpt: []string{"no-new-privileges"}, PidsLimit: 64},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.RemoveContainer(context.Background(), id, true) })
	if err := client.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	time.Sleep(wait)
	stream := &ackingStream{acks: make(chan uint64, MaxInFlight), ctx: ctx}
	shipper := &Shipper{Engine: client, Cursors: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Scan: 200 * time.Millisecond, Flush: 50 * time.Millisecond}
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- shipper.Run(runCtx, stream, 1) }()
	// The engine may run other managed containers, whose lines are shipped too: only this
	// test's container is kept.
	mine := func() []*agentv1.LogEntry {
		stream.mu.Lock()
		defer stream.mu.Unlock()
		var own []*agentv1.LogEntry
		for _, entry := range stream.entries {
			if entry.GetContainer() == name {
				own = append(own, entry)
			}
		}
		return own
	}
	// The cursor moves once the batch is acknowledged, after it was sent: wait for both.
	deadline := time.Now().Add(20 * time.Second)
	for {
		count := len(mine())
		_, kept, err := store.LogCursor(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		if count >= want && kept {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("got %d entries, cursor kept %v", count, kept)
		}
		time.Sleep(50 * time.Millisecond)
	}
	stop()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	return realRun{store: store, entries: mine()}
}

func lines(entries []*agentv1.LogEntry) []string {
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		out = append(out, entry.GetLine())
	}
	return out
}

func TestRealShipperSendsAContainersRedactedLinesAndKeepsItsCursor(t *testing.T) {
	run := shipReal(t, "sk-logs-r1-0", `echo "start"; echo "token is $TOKEN" >&2; sleep 300`,
		[]string{"TOKEN=sk_fake_redactme"}, map[string]string{SecretEnvLabel: "TOKEN"}, 0, 2)
	var stderr *agentv1.LogEntry
	for _, entry := range run.entries {
		if strings.Contains(entry.GetLine(), "sk_fake_redactme") {
			t.Fatalf("entry %v", entry)
		}
		if entry.GetStream() == agentv1.LogStream_LOG_STREAM_STDERR {
			stderr = entry
		}
	}
	if stderr == nil || stderr.GetLine() != "token is [redacted]" {
		t.Fatalf("stderr line %v", stderr)
	}
	at, ok, err := run.store.LogCursor(t.Context(), "sk-logs-r1-0")
	if err != nil || !ok || at.IsZero() {
		t.Fatalf("cursor %v %v %v", at, ok, err)
	}
}

// After an agent upgrade, a container created before the label printed a secret before and after
// the new shipper started: neither its backlog nor its new lines carry it (#470).
func TestRealShipperRedactsAContainerThatPredatesTheLabel(t *testing.T) {
	run := shipReal(t, "sk-logs-legacy-0", `echo "token=$TOKEN"; sleep 2; echo "later token=$TOKEN mode=$MODE"; sleep 300`,
		[]string{"TOKEN=sk_test_fake_upgrade_secret", "MODE=production"}, nil, time.Second, 2)
	if got := lines(run.entries); len(got) != 2 || got[0] != "token=[redacted]" || got[1] != "later token=[redacted] mode=[redacted]" {
		t.Fatalf("lines %q", got)
	}
}

// A container that predates the label but has no secret is redacted the same way: absence is not
// "no secret". A new one without secrets has an empty label, and its values are shipped.
func TestRealShipperTellsAMissingLabelFromAnEmptyOne(t *testing.T) {
	legacy := shipReal(t, "sk-logs-legacy-1", `echo "mode=$MODE"; sleep 300`, []string{"MODE=production"}, nil, 0, 1)
	if got := lines(legacy.entries); len(got) != 1 || got[0] != "mode=[redacted]" {
		t.Fatalf("legacy lines %q", got)
	}
	empty := shipReal(t, "sk-logs-empty-0", `echo "mode=$MODE"; sleep 300`, []string{"MODE=production"}, map[string]string{SecretEnvLabel: ""}, 0, 1)
	if got := lines(empty.entries); len(got) != 1 || got[0] != "mode=production" {
		t.Fatalf("empty-label lines %q", got)
	}
}

// A labelled multiline secret printed unchanged, on both streams and with CRLF line ends, leaves
// none of its lines (#471).
func TestRealShipperRedactsEachLineOfAMultilineSecret(t *testing.T) {
	key := "fake-key-line-one\r\nfake-key-line-two\r\nfake-key-line-three"
	run := shipReal(t, "sk-logs-multi-0", `printf '%s\n' "$KEY"; printf '%s\n' "$KEY" >&2; sleep 300`,
		[]string{"KEY=" + key}, map[string]string{SecretEnvLabel: "KEY"}, 0, 6)
	for _, entry := range run.entries {
		if strings.Contains(entry.GetLine(), "fake-key") || strings.TrimSuffix(entry.GetLine(), "\r") != Redacted {
			t.Fatalf("entry %v", entry)
		}
	}
}

// A line cut at its bound in the middle of a secret leaves no start of it (#471).
func TestRealShipperRedactsTheStartOfASecretCutAtTheLineBound(t *testing.T) {
	printed := "sk_test_fake_cut_secret_0123456789"
	pad := strings.Repeat("x", docker.MaxLogLine-12)
	run := shipReal(t, "sk-logs-cut-0", `echo "$PAD$TOKEN"; sleep 300`,
		[]string{"PAD=" + pad, "TOKEN=" + printed}, map[string]string{SecretEnvLabel: "TOKEN"}, 0, 1)
	entry := run.entries[0]
	if !entry.GetTruncated() || entry.GetLine() != pad+Redacted || strings.Contains(entry.GetLine(), printed[:8]) {
		t.Fatalf("line ends %q, truncated %v", entry.GetLine()[len(entry.GetLine())-40:], entry.GetTruncated())
	}
}
