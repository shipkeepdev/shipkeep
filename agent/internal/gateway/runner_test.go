package gateway

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/actions"
	nodecredentials "github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
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
	connection := g.connects.Add(1)
	if err := stream.Send(&agentv1.ConnectResponse{Msg: &agentv1.ConnectResponse_Welcome{Welcome: &agentv1.Welcome{NodeId: testNode, LeaseEpoch: 1, HeartbeatInterval: durationpb.New(time.Second), Metrics: g.acceptsMetrics.Load()}}}); err != nil {
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
		select {
		case <-g.drop:
			return status.Error(codes.Unavailable, "simulated stream loss")
		default:
		}
		if update := request.GetActionUpdate(); update != nil && g.streamUpdates != nil {
			g.streamUpdates <- streamUpdate{connection: connection, update: update}
			continue
		}
		if update := request.GetActionUpdate(); update != nil && g.updates != nil {
			g.updates <- update
			continue
		}
		if sample := request.GetMetricsReport(); sample != nil {
			if !g.acceptsMetrics.Load() {
				g.unexpected.Add(1)
				continue
			}
			if g.metrics != nil {
				select {
				case g.metrics <- sample:
				case <-stream.Context().Done():
					return nil
				}
			}
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
	bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server.disconnect.Store(true)
	runner := Runner{Endpoint: Endpoint{Address: address}, StateDir: t.TempDir(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
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
	bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := bundle.Save(dir); err != nil {
		t.Fatal(err)
	}
	runner := Runner{Endpoint: Endpoint{Address: address}, StateDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
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
	bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server.rejected.Store(true)
	runner := Runner{Endpoint: Endpoint{Address: address}, StateDir: t.TempDir(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
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
	bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := bundle.Save(dir); err != nil {
		t.Fatal(err)
	}
	failures := 2
	runner := Runner{Endpoint: Endpoint{Address: address}, StateDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
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
	bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := bundle.Save(dir); err != nil {
		t.Fatal(err)
	}
	runner := Runner{Endpoint: Endpoint{Address: address}, StateDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
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
	bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server.updates = make(chan *agentv1.ActionUpdate, 8)
	server.action.Store(&agentv1.ActionRequest{ActionId: "019d0000-0000-7000-8000-00000000000a"})
	server.cancel.Store(&agentv1.CancelAction{ActionId: "019d0000-0000-7000-8000-00000000000b"})
	actions := fakeActions{cancelled: make(chan string, 1)}
	runner := Runner{Endpoint: Endpoint{Address: address}, StateDir: t.TempDir(), Actions: actions, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
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

// Metrics go only to a control plane whose Welcome says it accepts them (ADR 0024), with the
// session's epoch; an older one never receives a frame it does not know.
func TestRunnerSendsMetricsOnlyWhenTheControlPlaneAcceptsThem(t *testing.T) {
	for _, accepts := range []bool{true, false} {
		address, server := startGateway(t, true)
		server.acceptsMetrics.Store(accepts)
		server.metrics = make(chan *agentv1.MetricsReport, 8)
		bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
		if err != nil {
			t.Fatal(err)
		}
		runner := Runner{
			Endpoint: Endpoint{Address: address}, StateDir: t.TempDir(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			MetricsInterval: 20 * time.Millisecond,
			Metrics: func(context.Context) (*agentv1.MetricsReport, error) {
				return &agentv1.MetricsReport{Node: &agentv1.NodeMetrics{CpuCores: 2}}, nil
			},
		}
		ctx, cancel := context.WithCancel(t.Context())
		stopped := make(chan error, 1)
		go func() { stopped <- runner.Run(ctx, bundle) }()
		if accepts {
			select {
			case sample := <-server.metrics:
				if sample.GetLeaseEpoch() != 1 || sample.GetNode().GetCpuCores() != 2 {
					t.Fatalf("sample = %v", sample)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("no metrics report was sent")
			}
		} else {
			deadline := time.Now().Add(5 * time.Second)
			for server.heartbeats.Load() < 2 && time.Now().Before(deadline) {
				time.Sleep(10 * time.Millisecond)
			}
			if server.heartbeats.Load() < 2 || server.unexpected.Load() != 0 {
				t.Fatalf("heartbeats %d, metrics sent to a gateway that refuses them %d", server.heartbeats.Load(), server.unexpected.Load())
			}
		}
		cancel()
		if err := <-stopped; err != nil {
			t.Fatal(err)
		}
	}
}

// Issue #483, over real gRPC: an action still running when its stream ends reports its outcome
// on the replacement stream, once the control plane delivers it there again, without a third
// connection and without running its step twice.
func TestRunnerReattachesARunningActionToTheReplacementStream(t *testing.T) {
	address, server := startGateway(t, true)
	bundle, err := Enroll(t.Context(), Endpoint{Address: address}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	server.streamUpdates = make(chan streamUpdate, 64)
	server.drop = make(chan struct{}, 1)
	request := &agentv1.ActionRequest{
		ActionId:       "019d0000-0000-7000-8000-0000000000aa",
		IdempotencyKey: "d:483:net",
		DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
		LeaseEpoch:     1,
		Action:         &agentv1.ActionRequest_EnsureNetwork{EnsureNetwork: &agentv1.EnsureNetwork{Name: "sk-483"}},
	}
	server.action.Store(request)
	store, err := journal.Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	var applied atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	dispatcher := &actions.Dispatcher{
		Journal: store,
		Epoch:   func() uint64 { return 1 },
		Handlers: map[string]actions.Handler{"ensure_network": {
			Plan: func(*agentv1.ActionRequest) (journal.Plan, error) {
				return journal.Plan{Version: "test-v1", Steps: []journal.Step{{
					Name: "create", RetrySafe: true,
					Apply: func(ctx context.Context) (journal.Outcome, error) {
						if applied.Add(1) == 1 {
							close(started)
						}
						select {
						case <-release:
							return journal.Outcome{ResourceID: "net-483"}, nil
						case <-ctx.Done():
							return journal.Outcome{}, ctx.Err()
						}
					},
					Compensate: func(context.Context) error { return nil },
				}}}, nil
			},
			Result: func(outcome journal.Outcome) *agentv1.ActionResult {
				return &agentv1.ActionResult{Result: &agentv1.ActionResult_ContainerId{ContainerId: outcome.ResourceID}}
			},
		}},
	}
	runner := Runner{Endpoint: Endpoint{Address: address}, StateDir: t.TempDir(), Actions: dispatcher, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan error, 1)
	go func() { stopped <- runner.Run(ctx, bundle) }()
	defer func() {
		cancel()
		if err := <-stopped; err != nil {
			t.Error(err)
		}
	}()
	waitFor := func(connection int32, state agentv1.OperationState) *agentv1.ActionUpdate {
		t.Helper()
		deadline := time.After(20 * time.Second)
		for {
			select {
			case got := <-server.streamUpdates:
				if got.connection == connection && got.update.GetState() == state {
					return got.update
				}
				if got.update.GetState() == agentv1.OperationState_OPERATION_STATE_SUCCEEDED && got.connection != connection {
					t.Fatalf("the outcome came on connection %d, not %d", got.connection, connection)
				}
			case <-deadline:
				t.Fatalf("no %v update on connection %d", state, connection)
			}
		}
	}
	<-started
	waitFor(1, agentv1.OperationState_OPERATION_STATE_RUNNING)
	// The first stream ends while the step runs; the control plane delivers the action again.
	server.action.Store(request)
	server.drop <- struct{}{}
	waitFor(2, agentv1.OperationState_OPERATION_STATE_RUNNING)
	close(release)
	final := waitFor(2, agentv1.OperationState_OPERATION_STATE_SUCCEEDED)
	if final.GetResult().GetContainerId() != "net-483" {
		t.Fatalf("the outcome came without its result: %v", final)
	}
	if applied.Load() != 1 || server.connects.Load() != 2 {
		t.Fatalf("step ran %d times over %d connections", applied.Load(), server.connects.Load())
	}
}
