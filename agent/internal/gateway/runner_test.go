package gateway

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	nodecredentials "github.com/samuelmbabhazi/shipkeep/agent/internal/credentials"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

func (g *testGateway) Connect(stream grpc.BidiStreamingServer[agentv1.ConnectRequest, agentv1.ConnectResponse]) error {
	if g.rejected.Load() {
		return status.Error(codes.Unauthenticated, "private revoked credential detail")
	}
	request, err := stream.Recv()
	if err != nil {
		return err
	}
	if request.GetHello() == nil {
		return status.Error(codes.InvalidArgument, "missing Hello")
	}
	g.connects.Add(1)
	if err := stream.Send(&agentv1.ConnectResponse{Msg: &agentv1.ConnectResponse_Welcome{Welcome: &agentv1.Welcome{NodeId: testNode, LeaseEpoch: 1, HeartbeatInterval: durationpb.New(time.Second)}}}); err != nil {
		return err
	}
	if g.disconnect.Swap(false) {
		return status.Error(codes.Unavailable, "simulated control plane restart")
	}
	for {
		request, err := stream.Recv()
		if err != nil {
			return err
		}
		if request.GetHeartbeat() == nil {
			return status.Error(codes.InvalidArgument, "missing heartbeat")
		}
		g.heartbeats.Add(1)
	}
}

func TestRunnerReconnectsAndSendsHeartbeats(t *testing.T) {
	address, server := startGateway(t, true)
	bundle, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server.disconnect.Store(true)
	runner := Runner{Address: address, StateDir: t.TempDir(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan error, 1)
	go func() { stopped <- runner.Run(ctx, bundle) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-stopped:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("runner did not stop")
		}
	})
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for server.connects.Load() < 2 || server.heartbeats.Load() < 1 {
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("agent did not reconnect and heartbeat")
		}
	}
}

func TestRunnerPersistsRenewalBeforeReconnecting(t *testing.T) {
	address, server := startGateway(t, true)
	server.renewSoon.Store(true)
	bundle, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := bundle.Save(dir); err != nil {
		t.Fatal(err)
	}
	runner := Runner{Address: address, StateDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	renewed, err := runner.cycle(ctx, bundle)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := nodecredentials.Load(dir, "")
	if err != nil || !stored.Key.Equal(renewed.Key) || stored.Key.Equal(bundle.Key) {
		t.Fatal("renewal was not atomically persisted")
	}
	if server.connects.Load() != 0 {
		t.Fatal("opened a stream with a certificate already due for renewal")
	}
}

func TestRunnerStopsRetryingRejectedCredentials(t *testing.T) {
	address, server := startGateway(t, true)
	bundle, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server.rejected.Store(true)
	runner := Runner{Address: address, StateDir: t.TempDir(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	_, err = runner.cycle(t.Context(), bundle)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("rejection code lost: %v", err)
	}
}

func TestBackoffIsBoundedAndJittered(t *testing.T) {
	values := map[time.Duration]bool{}
	for attempt := 0; attempt < 20; attempt++ {
		base := min(time.Second<<min(attempt, 5), 30*time.Second)
		delay := retryDelay(attempt)
		if delay < base/2 || delay >= base {
			t.Fatalf("delay outside exponential bound: %s", delay)
		}
		values[delay] = true
	}
	if len(values) < 2 {
		t.Fatal("backoff has no jitter")
	}
}
