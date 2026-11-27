package logship

import (
	"fmt"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const buildAction = "0192f0c0-0000-7000-8000-0000000000b1"

func buildEntries(batches []*agentv1.LogBatch) []*agentv1.LogEntry {
	var out []*agentv1.LogEntry
	for _, batch := range batches {
		for _, entry := range batch.GetEntries() {
			if entry.GetActionId() != "" {
				out = append(out, entry)
			}
		}
	}
	return out
}

// ADR 0032: a build's lines go out with the containers' ones, tagged with the action and with no
// container, and only an acknowledgement lets the agent forget them.
func TestShipperSendsBuildOutputAndForgetsItOnlyOnceAcknowledged(t *testing.T) {
	shipper, _, cursors, stream, ctx, cancel := world(0)
	builds := NewBuildOutput()
	shipper.Builds = builds
	builds.Line(buildAction, "#1 [internal] load git source")
	builds.Line(buildAction, "#2 RUN npm ci")
	done := make(chan error, 1)
	go func() { done <- shipper.Run(ctx, stream, 7) }()
	eventually(t, func() bool { return len(buildEntries(stream.batches())) == 2 })
	entries := buildEntries(stream.batches())
	if entries[0].GetContainer() != "" || entries[0].GetLine() != "#1 [internal] load git source" || entries[1].GetActionId() != buildAction || entries[0].GetTime() == nil {
		t.Fatalf("entries = %v", entries)
	}
	// A line written while the stream runs follows at once.
	builds.Line(buildAction, "#2 DONE")
	eventually(t, func() bool { return len(buildEntries(stream.batches())) == 3 })
	if len(builds.after(0, 10)) != 3 {
		t.Fatal("lines forgotten before their acknowledgement")
	}
	for seq := range uint64(len(stream.batches())) {
		stream.acks <- ack(seq + 1)
	}
	eventually(t, func() bool { return len(builds.after(0, 10)) == 0 })
	// No cursor is ever written for a build: it is no container.
	cursors.mu.Lock()
	_, cursor := cursors.at[""]
	cursors.mu.Unlock()
	if cursor {
		t.Fatal("a cursor was written for a build line")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A stream that fails before acknowledging loses nothing: the next one sends those lines again.
func TestBuildOutputIsSentAgainOnTheNextStream(t *testing.T) {
	shipper, _, _, first, ctx, cancel := world(0)
	builds := NewBuildOutput()
	shipper.Builds = builds
	builds.Line(buildAction, "#1 RUN make")
	done := make(chan error, 1)
	go func() { done <- shipper.Run(ctx, first, 1) }()
	eventually(t, func() bool { return len(buildEntries(first.batches())) == 1 })
	close(first.acks)
	if err := <-done; err == nil {
		t.Fatal("a failed stream ended without an error")
	}
	cancel()
	shipper2, _, _, second, ctx2, cancel2 := world(0)
	defer cancel2()
	shipper2.Builds = builds
	go func() { _ = shipper2.Run(ctx2, second, 2) }()
	eventually(t, func() bool { return len(buildEntries(second.batches())) == 1 })
	if got := buildEntries(second.batches())[0].GetLine(); got != "#1 RUN make" {
		t.Fatalf("sent again: %q", got)
	}
}

// A build never waits for the stream: past its bounds, the buffer drops the oldest lines.
func TestBuildOutputDropsTheOldestLinesPastItsBounds(t *testing.T) {
	builds := NewBuildOutput()
	at := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	for i := range maxBuildLines + 5 {
		builds.line(buildAction, fmt.Sprintf("line %d", i), at)
	}
	kept := builds.after(0, maxBuildLines+10)
	if len(kept) != maxBuildLines || kept[0].entry.GetLine() != "line 5" || builds.Dropped() != 5 {
		t.Fatalf("kept %d from %q, dropped %d", len(kept), kept[0].entry.GetLine(), builds.Dropped())
	}
	big := NewBuildOutput()
	line := strings.Repeat("x", 16<<10)
	for range maxBuildBytes/len(line) + 3 {
		big.line(buildAction, line, at)
	}
	if got := len(big.after(0, maxBuildLines)); got != maxBuildBytes/len(line) {
		t.Fatalf("kept %d lines of 16 KiB", got)
	}
	// Writing never blocks, even with nobody reading.
	finished := make(chan struct{})
	go func() {
		for range 1000 {
			builds.Line(buildAction, "more")
		}
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("a build waited for its output to be read")
	}
}
