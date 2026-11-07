package gateway

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	nodecredentials "github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
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
	if action := g.action.Swap(nil); action != nil {
		if err := stream.Send(&agentv1.ConnectResponse{Msg: &agentv1.ConnectResponse_ActionRequest{ActionRequest: action}}); err != nil {
			return err
		}
	}
	if cancel := g.cancel.Swap(nil); cancel != nil {
		if err := stream.Send(&agentv1.ConnectResponse{Msg: &agentv1.ConnectResponse_CancelAction{CancelAction: cancel}}); err != nil {
			return err
		}
	}
	for {
		request, err := stream.Recv()
		if err != nil {
			return err
		}
		if update := request.GetActionUpdate(); update != nil && g.updates != nil {
			g.updates <- update
			continue
		}
		if report := request.GetStateReport(); report != nil && g.reports != nil {
			select {
			case g.reports <- report:
			case <-stream.Context().Done():
				return nil
			}
			continue
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

func TestRunnerRetriesSavingRenewedCredentials(t *testing.T) {
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
	failures := 2
	runner := Runner{Address: address, StateDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	runner.save = func(b nodecredentials.Bundle) error {
		if failures > 0 {
			failures--
			return errors.New("no space left on device")
		}
		return b.Save(dir)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	renewed, err := runner.cycle(ctx, bundle)
	if err != nil {
		t.Fatalf("transient disk errors discarded the renewed credentials: %v", err)
	}
	stored, err := nodecredentials.Load(dir, "")
	if err != nil || !stored.Key.Equal(renewed.Key) || failures != 0 {
		t.Fatal("renewed credentials were not persisted after the disk recovered")
	}
}

func TestRunnerFinishesRenewalWhenShutdownIsRequested(t *testing.T) {
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
	ctx, cancel := context.WithCancel(t.Context())
	cancel() // SIGTERM arrives as the renewal starts.
	renewed, err := runner.cycle(ctx, bundle)
	if err != nil {
		t.Fatalf("renewal abandoned on shutdown: %v", err)
	}
	stored, err := nodecredentials.Load(dir, "")
	if err != nil || !stored.Key.Equal(renewed.Key) || stored.Key.Equal(bundle.Key) {
		t.Fatal("renewal committed by the server was not persisted before shutdown")
	}
}

type fakeActions struct {
	cancelled chan string
}

func (f fakeActions) Handle(_ context.Context, req *agentv1.ActionRequest, send func(*agentv1.ActionUpdate)) {
	send(&agentv1.ActionUpdate{ActionId: req.GetActionId(), State: agentv1.OperationState_OPERATION_STATE_RUNNING})
	send(&agentv1.ActionUpdate{ActionId: req.GetActionId(), State: agentv1.OperationState_OPERATION_STATE_SUCCEEDED})
}

func (f fakeActions) Cancel(id string) bool {
	f.cancelled <- id
	return true
}

func TestRunnerDeliversActionsAndForwardsUpdates(t *testing.T) {
	address, server := startGateway(t, true)
	bundle, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server.updates = make(chan *agentv1.ActionUpdate, 8)
	server.action.Store(&agentv1.ActionRequest{ActionId: "019d0000-0000-7000-8000-00000000000a"})
	server.cancel.Store(&agentv1.CancelAction{ActionId: "019d0000-0000-7000-8000-00000000000b"})
	actions := fakeActions{cancelled: make(chan string, 1)}
	runner := Runner{Address: address, StateDir: t.TempDir(), Actions: actions, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan error, 1)
	go func() { stopped <- runner.Run(ctx, bundle) }()
	defer func() {
		cancel()
		if err := <-stopped; err != nil {
			t.Error(err)
		}
	}()
	for _, want := range []agentv1.OperationState{agentv1.OperationState_OPERATION_STATE_RUNNING, agentv1.OperationState_OPERATION_STATE_SUCCEEDED} {
		select {
		case update := <-server.updates:
			if update.GetState() != want || update.GetActionId() != "019d0000-0000-7000-8000-00000000000a" {
				t.Fatalf("unexpected update %v", update)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("action update not forwarded")
		}
	}
	select {
	case id := <-actions.cancelled:
		if id != "019d0000-0000-7000-8000-00000000000b" {
			t.Fatalf("wrong cancellation %q", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancellation not delivered")
	}
}
