//go:build integration

package logship

import (
	"context"
	"io"
	"log/slog"
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

func TestRealShipperSendsAContainersRedactedLinesAndKeepsItsCursor(t *testing.T) {
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
	defer store.Close() //nolint:errcheck // test store
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	repository, digest, _ := strings.Cut(realBusybox, "@")
	if err := client.PullImage(ctx, repository, digest, nil); err != nil {
		t.Fatal(err)
	}
	id, err := client.CreateContainer(ctx, "", docker.ContainerConfig{
		Image: realBusybox, Cmd: []string{"sh", "-c", `echo "start"; echo "token is $TOKEN" >&2; sleep 300`},
		Env:        []string{"TOKEN=sk_fake_redactme"},
		Labels:     map[string]string{docker.ManagedLabel: "true", NameLabel: "sk-logs-r1-0", SecretEnvLabel: "TOKEN"},
		HostConfig: docker.HostConfig{NetworkMode: "none", SecurityOpt: []string{"no-new-privileges"}, PidsLimit: 64},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.RemoveContainer(context.Background(), id, true) })
	if err := client.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	stream := &ackingStream{acks: make(chan uint64, MaxInFlight), ctx: ctx}
	shipper := &Shipper{Engine: client, Cursors: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Scan: 200 * time.Millisecond, Flush: 50 * time.Millisecond}
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- shipper.Run(runCtx, stream, 1) }()
	deadline := time.Now().Add(20 * time.Second)
	// The engine may run other managed containers, whose lines are shipped too: only this
	// test's container is checked.
	mine := func() []*agentv1.LogEntry {
		stream.mu.Lock()
		defer stream.mu.Unlock()
		var own []*agentv1.LogEntry
		for _, entry := range stream.entries {
			if entry.GetContainer() == "sk-logs-r1-0" {
				own = append(own, entry)
			}
		}
		return own
	}
	// The cursor moves once the batch is acknowledged, after it was sent: wait for both.
	for {
		count := len(mine())
		_, kept, err := store.LogCursor(ctx, "sk-logs-r1-0")
		if err != nil {
			t.Fatal(err)
		}
		if count >= 2 && kept {
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
	stream.mu.Lock()
	for _, entry := range stream.entries {
		if strings.Contains(entry.GetLine(), "sk_fake_redactme") {
			t.Fatalf("entry %v", entry)
		}
	}
	stream.mu.Unlock()
	var stderr *agentv1.LogEntry
	for _, entry := range mine() {
		if entry.GetContainer() != "sk-logs-r1-0" {
			t.Fatalf("entry %v", entry)
		}
		if entry.GetStream() == agentv1.LogStream_LOG_STREAM_STDERR {
			stderr = entry
		}
	}
	if stderr == nil || stderr.GetLine() != "token is [redacted]" {
		t.Fatalf("stderr line %v", stderr)
	}
	at, ok, err := store.LogCursor(ctx, "sk-logs-r1-0")
	if err != nil || !ok || at.IsZero() {
		t.Fatalf("cursor %v %v %v", at, ok, err)
	}
}
