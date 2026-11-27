package logship

import (
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// What the agent keeps of build output the control plane has not acknowledged yet (ADR 0032):
// beyond either bound, the oldest lines go first.
const (
	maxBuildLines = 8192
	maxBuildBytes = 8 << 20
)

// BuildOutput holds the lines of the server's builds until the log stream acknowledges them. A
// build writes to it without ever waiting: a line that does not fit pushes the oldest out. A line
// sent on a stream that failed before its acknowledgement is sent again on the next one.
type BuildOutput struct {
	mu      sync.Mutex
	entries []buildEntry
	bytes   int
	next    uint64
	dropped uint64
	// ready is signalled when a line arrives.
	ready chan struct{}
}

type buildEntry struct {
	seq   uint64
	entry *agentv1.LogEntry
}

// NewBuildOutput is an empty buffer.
func NewBuildOutput() *BuildOutput {
	return &BuildOutput{ready: make(chan struct{}, 1)}
}

// Line keeps one line of an action's output, at the time it arrived.
func (b *BuildOutput) Line(actionID, line string) {
	b.line(actionID, line, time.Now())
}

func (b *BuildOutput) line(actionID, line string, at time.Time) {
	b.mu.Lock()
	b.next++
	b.entries = append(b.entries, buildEntry{seq: b.next, entry: &agentv1.LogEntry{
		ActionId: actionID,
		Stream:   agentv1.LogStream_LOG_STREAM_STDOUT,
		Time:     timestamppb.New(at),
		Line:     line,
	}})
	b.bytes += len(line)
	for len(b.entries) > maxBuildLines || b.bytes > maxBuildBytes {
		b.bytes -= len(b.entries[0].entry.GetLine())
		b.entries = b.entries[1:]
		b.dropped++
	}
	b.mu.Unlock()
	select {
	case b.ready <- struct{}{}:
	default:
	}
}

// after returns up to limit lines that follow seq, oldest first.
func (b *BuildOutput) after(seq uint64, limit int) []buildEntry {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []buildEntry
	for _, entry := range b.entries {
		if entry.seq > seq {
			out = append(out, entry)
			if len(out) == limit {
				break
			}
		}
	}
	return out
}

// acknowledged forgets the lines up to seq: the control plane has them.
func (b *BuildOutput) acknowledged(seq uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := 0
	for kept < len(b.entries) && b.entries[kept].seq <= seq {
		b.bytes -= len(b.entries[kept].entry.GetLine())
		kept++
	}
	b.entries = b.entries[kept:]
}

// Dropped is how many lines were pushed out before the stream took them.
func (b *BuildOutput) Dropped() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.dropped
}
