package logship

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

type fakeEngine struct {
	lines []docker.LogLine
	mu    sync.Mutex
	since []time.Time
}

func (f *fakeEngine) ManagedContainers(context.Context) ([]docker.ContainerSummary, error) {
	return []docker.ContainerSummary{{ID: "c1", State: "running"}, {ID: "c2", State: "exited"}}, nil
}

func (f *fakeEngine) Container(_ context.Context, id string) (docker.Container, error) {
	var container docker.Container
	container.ID = id
	container.Config.Labels = map[string]string{NameLabel: "sk-web-r1-0", SecretEnvLabel: "TOKEN"}
	container.Config.Env = []string{"TOKEN=sk_fake_abcdefgh"}
	return container, nil
}

func (f *fakeEngine) FollowLogs(ctx context.Context, _ string, since time.Time, emit func(docker.LogLine) error) error {
	f.mu.Lock()
	f.since = append(f.since, since)
	f.mu.Unlock()
	for _, line := range f.lines {
		if err := emit(line); err != nil {
			return err
		}
	}
	<-ctx.Done()
	return ctx.Err()
}

type fakeCursors struct {
	mu   sync.Mutex
	at   map[string]time.Time
	sets int
}

func (f *fakeCursors) LogCursor(_ context.Context, container string) (time.Time, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	at, ok := f.at[container]
	return at, ok, nil
}

func (f *fakeCursors) SetLogCursor(_ context.Context, container string, at time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.at[container] = at
	f.sets++
	return nil
}

type fakeStream struct {
	mu   sync.Mutex
	sent []*agentv1.ShipLogsRequest
	acks chan *agentv1.ShipLogsResponse
	ctx  context.Context
}

func (f *fakeStream) Send(frame *agentv1.ShipLogsRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, frame)
	return nil
}

func (f *fakeStream) Recv() (*agentv1.ShipLogsResponse, error) {
	select {
	case ack, ok := <-f.acks:
		if !ok {
			return nil, io.EOF
		}
		return ack, nil
	case <-f.ctx.Done():
		return nil, f.ctx.Err()
	}
}

func (f *fakeStream) batches() []*agentv1.LogBatch {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*agentv1.LogBatch
	for _, frame := range f.sent {
		if batch := frame.GetBatch(); batch != nil {
			out = append(out, batch)
		}
	}
	return out
}

func ack(seq uint64) *agentv1.ShipLogsResponse {
	return &agentv1.ShipLogsResponse{Frame: &agentv1.ShipLogsResponse_Ack{Ack: &agentv1.LogAck{Seq: seq}}}
}

var base = time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)

func world(lines int) (*Shipper, *fakeEngine, *fakeCursors, *fakeStream, context.Context, context.CancelFunc) {
	engine := &fakeEngine{}
	for i := range lines {
		engine.lines = append(engine.lines, docker.LogLine{Stream: docker.Stdout, Time: base.Add(time.Duration(i) * time.Millisecond), Text: fmt.Sprintf("line %d token=sk_fake_abcdefgh", i)})
	}
	cursors := &fakeCursors{at: map[string]time.Time{"sk-web-r1-0": base.Add(-time.Hour)}}
	ctx, cancel := context.WithCancel(context.Background())
	stream := &fakeStream{acks: make(chan *agentv1.ShipLogsResponse, 16), ctx: ctx}
	shipper := &Shipper{Engine: engine, Cursors: cursors, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Scan: time.Hour, Flush: 10 * time.Millisecond}
	return shipper, engine, cursors, stream, ctx, cancel
}

func eventually(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("condition never met")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestShipperSendsRedactedLinesFromTheCursorAndMovesItOnAck(t *testing.T) {
	shipper, engine, cursors, stream, ctx, cancel := world(3)
	done := make(chan error, 1)
	go func() { done <- shipper.Run(ctx, stream, 7) }()
	eventually(t, func() bool { return len(stream.batches()) == 1 })
	stream.mu.Lock()
	open := stream.sent[0].GetOpen()
	stream.mu.Unlock()
	if open.GetLeaseEpoch() != 7 {
		t.Fatalf("first frame: %v", stream.sent[0])
	}
	batch := stream.batches()[0]
	if batch.GetSeq() != 1 || len(batch.GetEntries()) != 3 {
		t.Fatalf("batch: %v", batch)
	}
	for _, entry := range batch.GetEntries() {
		if entry.GetContainer() != "sk-web-r1-0" || strings.Contains(entry.GetLine(), "sk_fake") || !strings.Contains(entry.GetLine(), "[redacted]") {
			t.Fatalf("entry: %v", entry)
		}
	}
	// Followed from the cursor; the cursor moves only once the control plane kept the batch.
	if !engine.since[0].Equal(base.Add(-time.Hour)) {
		t.Fatalf("followed from %v", engine.since[0])
	}
	if cursors.sets != 0 {
		t.Fatal("a cursor moved before its acknowledgement")
	}
	stream.acks <- ack(1)
	eventually(t, func() bool {
		cursors.mu.Lock()
		defer cursors.mu.Unlock()
		return cursors.at["sk-web-r1-0"].Equal(base.Add(2 * time.Millisecond))
	})
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestShipperBoundsBatchesAndWaitsForAcknowledgements(t *testing.T) {
	shipper, _, _, stream, ctx, cancel := world(MaxEntries*6 + 10)
	defer cancel()
	go func() { _ = shipper.Run(ctx, stream, 1) }()
	// Four batches in flight, then nothing until one is acknowledged.
	eventually(t, func() bool { return len(stream.batches()) == MaxInFlight })
	time.Sleep(50 * time.Millisecond)
	if got := len(stream.batches()); got != MaxInFlight {
		t.Fatalf("%d batches in flight", got)
	}
	for _, batch := range stream.batches() {
		if len(batch.GetEntries()) > MaxEntries {
			t.Fatalf("a batch of %d entries", len(batch.GetEntries()))
		}
	}
	stream.acks <- ack(1)
	eventually(t, func() bool { return len(stream.batches()) == MaxInFlight+1 })
}

func TestShipperStopsOnAnAcknowledgementOutOfOrder(t *testing.T) {
	shipper, _, _, stream, ctx, cancel := world(3)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- shipper.Run(ctx, stream, 1) }()
	eventually(t, func() bool { return len(stream.batches()) == 1 })
	stream.acks <- ack(9)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("an acknowledgement out of order was accepted")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the shipper went on")
	}
}
