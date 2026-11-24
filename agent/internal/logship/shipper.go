package logship

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Bounds of a batch (ADR 0029, SPEC 3.1).
const (
	MaxEntries  = 256
	MaxBatch    = 60 << 10
	MaxInFlight = 4
)

// NameLabel is the managed container's name, which the control plane maps to its allocation.
const NameLabel = "sk.name"

// SecretEnvLabel names the container's secret variables (actions.SecretEnvLabel).
const SecretEnvLabel = "sk.secret_env" //nolint:gosec // a label name, not a credential

// Engine is the part of the Docker client the shipper reads.
type Engine interface {
	ManagedContainers(ctx context.Context) ([]docker.ContainerSummary, error)
	Container(ctx context.Context, ref string) (docker.Container, error)
	FollowLogs(ctx context.Context, ref string, since time.Time, emit func(docker.LogLine) error) error
}

// Cursors keeps, for each container, the time of its last line the control plane kept.
type Cursors interface {
	LogCursor(ctx context.Context, container string) (time.Time, bool, error)
	SetLogCursor(ctx context.Context, container string, at time.Time) error
}

// Stream is the agent's side of one ShipLogs RPC.
type Stream interface {
	Send(*agentv1.ShipLogsRequest) error
	Recv() (*agentv1.ShipLogsResponse, error)
}

// Shipper follows every managed container and sends its lines in acknowledged batches.
type Shipper struct {
	Engine  Engine
	Cursors Cursors
	Logger  *slog.Logger
	// Scan is how often running containers are listed; Flush how long a batch may wait.
	Scan  time.Duration
	Flush time.Duration
}

type line struct {
	container string
	entry     *agentv1.LogEntry
	// at is where to read the container again from once the line is kept (LogLine.Resume).
	at time.Time
}

type batch struct {
	seq    uint64
	latest map[string]time.Time
}

// Run ships logs on stream until ctx ends or the stream fails. Running containers are followed
// from their cursor; a line arrives at least once, and none is lost while Docker still holds it.
func (s *Shipper) Run(ctx context.Context, stream Stream, epoch uint64) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := stream.Send(&agentv1.ShipLogsRequest{Frame: &agentv1.ShipLogsRequest_Open{Open: &agentv1.LogsOpen{LeaseEpoch: epoch}}}); err != nil {
		return fmt.Errorf("open log stream: %w", err)
	}
	lines := make(chan line, MaxEntries)
	var following sync.WaitGroup
	defer following.Wait()
	defer cancel()
	following.Go(func() { s.follow(ctx, lines) })
	// Acknowledgements free places in flight and move cursors.
	inFlight := make(chan batch, MaxInFlight)
	acked := make(chan error, 1)
	go func() { acked <- s.acknowledge(ctx, stream, inFlight) }()
	var (
		seq     uint64
		pending []*agentv1.LogEntry
		latest  = map[string]time.Time{}
		size    int
	)
	flush := time.NewTicker(s.every(s.Flush, time.Second))
	defer flush.Stop()
	send := func() error {
		if len(pending) == 0 {
			return nil
		}
		seq++
		// Taking a place first waits while four batches wait for their acknowledgement.
		select {
		case inFlight <- batch{seq: seq, latest: latest}:
		case <-ctx.Done():
			return ctx.Err()
		case err := <-acked:
			return err
		}
		if err := stream.Send(&agentv1.ShipLogsRequest{Frame: &agentv1.ShipLogsRequest_Batch{Batch: &agentv1.LogBatch{Seq: seq, Entries: pending}}}); err != nil {
			return fmt.Errorf("send log batch: %w", err)
		}
		pending, latest, size = nil, map[string]time.Time{}, 0
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-acked:
			return err
		case <-flush.C:
			if err := send(); err != nil {
				return err
			}
		case next := <-lines:
			cost := proto.Size(next.entry) + 8
			if len(pending) == MaxEntries || size+cost > MaxBatch {
				if err := send(); err != nil {
					return err
				}
			}
			pending = append(pending, next.entry)
			size += cost
			if next.at.After(latest[next.container]) {
				latest[next.container] = next.at
			}
		}
	}
}

// acknowledge reads acknowledgements, which come in order, and records each batch's cursors.
func (s *Shipper) acknowledge(ctx context.Context, stream Stream, inFlight <-chan batch) error {
	for {
		response, err := stream.Recv()
		if err != nil {
			return fmt.Errorf("receive log acknowledgement: %w", err)
		}
		ack := response.GetAck()
		if ack == nil {
			return errors.New("log stream sent something else than an acknowledgement")
		}
		var sent batch
		select {
		case sent = <-inFlight:
		default:
			return errors.New("log acknowledgement for no batch")
		}
		if ack.GetSeq() != sent.seq {
			return errors.New("log acknowledgement out of order")
		}
		for container, at := range sent.latest {
			if err := s.Cursors.SetLogCursor(ctx, container, at); err != nil {
				return err
			}
		}
	}
}

// follow starts a follower for every running managed container, until ctx ends.
func (s *Shipper) follow(ctx context.Context, lines chan<- line) {
	var followers sync.WaitGroup
	defer followers.Wait()
	var mu sync.Mutex
	active := map[string]bool{}
	ticker := time.NewTicker(s.every(s.Scan, 10*time.Second))
	defer ticker.Stop()
	for {
		containers, err := s.Engine.ManagedContainers(ctx)
		if err != nil && ctx.Err() == nil {
			s.Logger.Warn("containers not listed for logs", "error", err)
		}
		for _, container := range containers {
			mu.Lock()
			known := active[container.ID]
			if !known && container.State == "running" {
				active[container.ID] = true
			}
			mu.Unlock()
			if known || container.State != "running" {
				continue
			}
			followers.Go(func() {
				defer func() {
					mu.Lock()
					delete(active, container.ID)
					mu.Unlock()
				}()
				if err := s.followOne(ctx, container.ID, lines); err != nil && ctx.Err() == nil {
					s.Logger.Warn("container logs not followed", "container_id", container.ID, "error", err)
				}
			})
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// followOne sends one container's lines from its cursor until it stops or ctx ends.
func (s *Shipper) followOne(ctx context.Context, id string, lines chan<- line) error {
	container, err := s.Engine.Container(ctx, id)
	if err != nil {
		return fmt.Errorf("inspect container: %w", err)
	}
	name := container.Config.Labels[NameLabel]
	if name == "" {
		name = strings.TrimPrefix(container.Name, "/")
	}
	since, _, err := s.Cursors.LogCursor(ctx, name)
	if err != nil {
		return err
	}
	redactor := NewRedactor(container.Config.Env, container.Config.Labels[SecretEnvLabel])
	err = s.Engine.FollowLogs(ctx, id, since, func(output docker.LogLine) error {
		stream := agentv1.LogStream_LOG_STREAM_STDOUT
		if output.Stream == docker.Stderr {
			stream = agentv1.LogStream_LOG_STREAM_STDERR
		}
		text := redactor.Redact(output.Text)
		entry := &agentv1.LogEntry{Container: name, Stream: stream, Time: timestamppb.New(output.Time), Line: cut(text), Truncated: output.Truncated || len(text) > docker.MaxLogLine}
		select {
		case lines <- line{container: name, entry: entry, at: output.Resume}:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	if err != nil {
		return fmt.Errorf("follow container logs: %w", err)
	}
	return nil
}

// cut keeps a redacted line within the bound: "[redacted]" can be longer than what it replaced.
func cut(text string) string {
	if len(text) <= docker.MaxLogLine {
		return text
	}
	end := docker.MaxLogLine
	for end > 0 && (text[end]&0xC0) == 0x80 {
		end--
	}
	return text[:end]
}

func (s *Shipper) every(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
