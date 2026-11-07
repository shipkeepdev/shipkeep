package gateway

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	nodecredentials "github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

var errIdentity = errors.New("gateway rejected the node identity or epoch; operator recovery is required")

// renewalTimeout bounds the renewal exchange plus persistence, which must finish even when
// shutdown is signalled: once the control plane commits a renewal, the old certificate is revoked.
const renewalTimeout = 30 * time.Second

// ActionHandler executes control-plane actions. Handle runs on the agent's lifetime, not the
// stream's: a dropped connection never interrupts an action, only its progress updates.
type ActionHandler interface {
	Handle(ctx context.Context, req *agentv1.ActionRequest, send func(*agentv1.ActionUpdate))
	Cancel(id string) bool
}

// Runner owns one outbound stream and its reconnect/renewal lifecycle.
type Runner struct {
	Address  string
	StateDir string
	Version  string
	Facts    *agentv1.NodeFacts
	Logger   *slog.Logger
	// Actions executes ActionRequests; nil refuses them (identity and heartbeats only).
	Actions ActionHandler
	// Report is enabled by the daemon once the control plane supports state-report ingestion.
	Report func(context.Context) (*agentv1.StateReport, error)

	// inflight tracks running actions so Run returns only after they stopped.
	inflight sync.WaitGroup

	// save persists renewed credentials; nil means Bundle.Save. Tests inject disk failures here.
	save func(nodecredentials.Bundle) error
}

// Run preserves local credentials during outages and never silently re-enrolls a rejected node.
func (r *Runner) Run(ctx context.Context, bundle nodecredentials.Bundle) error {
	defer r.inflight.Wait()
	attempt := 0
	for ctx.Err() == nil {
		started := time.Now()
		updated, err := r.cycle(ctx, bundle)
		if ctx.Err() != nil {
			return nil // Parent cancellation is a clean shutdown, not a failed connection.
		}
		if err == nil {
			bundle = updated
			attempt = 0
			continue
		}
		if errors.Is(err, errIdentity) || status.Code(err) == codes.Unauthenticated || status.Code(err) == codes.FailedPrecondition {
			r.Logger.Error("agent credentials rejected; operator recovery is required")
			<-ctx.Done()
			return nil
		}
		// Remote error text is deliberately omitted; it can contain hostile or sensitive content.
		r.Logger.Warn("agent connection interrupted", "code", status.Code(err).String())
		if time.Since(started) >= time.Minute {
			attempt = 0
		}
		timer := time.NewTimer(retryDelay(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if attempt < 5 {
			attempt++
		}
	}
	return nil
}

func (r *Runner) cycle(ctx context.Context, bundle nodecredentials.Bundle) (nodecredentials.Bundle, error) {
	pair, err := bundle.Validate("")
	if err != nil {
		return bundle, errIdentity
	}
	conn, err := Open(r.Address, bundle)
	if err != nil {
		return bundle, err
	}
	defer conn.Close() //nolint:errcheck // stream cancellation below finishes before connection close
	client := agentv1.NewAgentGatewayServiceClient(conn)
	renewAt := nodecredentials.RenewalTime(pair)
	if time.Now().Before(renewAt) {
		if err := r.session(ctx, client, bundle, renewAt); err != nil {
			return bundle, err
		}
	}
	// A cancelled RPC could still commit on the server and revoke the old certificate, so the
	// exchange is not tied to shutdown.
	renewCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), renewalTimeout)
	defer cancel()
	renewed, err := Renew(renewCtx, client, bundle)
	if err != nil {
		return bundle, err
	}
	if err := r.persist(ctx, renewed); err != nil {
		// Only reachable once shutdown was requested and the last write failed too. The renewed
		// credentials are still the only valid ones: hand them back, never the revoked bundle.
		r.Logger.Error("renewed agent certificate could not be saved; operator recovery may be required")
		return renewed, errIdentity
	}
	r.Logger.Info("agent certificate renewed")
	return renewed, nil
}

// persist keeps retrying a failed write of renewed credentials (for example a full disk) with
// bounded backoff. The renewed bundle exists only in memory and the old one is already revoked,
// so giving up early would force a re-enrollment. After shutdown is requested, one final write is
// attempted.
func (r *Runner) persist(ctx context.Context, renewed nodecredentials.Bundle) error {
	save := r.save
	if save == nil {
		save = func(b nodecredentials.Bundle) error { return b.Save(r.StateDir) }
	}
	for attempt := 0; ; attempt++ {
		err := save(renewed)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("save renewed credentials during shutdown: %w", err)
		}
		r.Logger.Warn("saving renewed agent credentials failed; retrying", "attempt", attempt+1)
		timer := time.NewTimer(retryDelay(min(attempt, 5)))
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (r *Runner) session(ctx context.Context, client agentv1.AgentGatewayServiceClient, bundle nodecredentials.Bundle, renewAt time.Time) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := client.Connect(streamCtx)
	if err != nil {
		return fmt.Errorf("connect agent stream: %w", err)
	}
	if err := stream.Send(&agentv1.ConnectRequest{Msg: &agentv1.ConnectRequest_Hello{Hello: &agentv1.Hello{NodeId: bundle.NodeID, LeaseEpoch: bundle.LeaseEpoch, AgentVersion: r.Version, Facts: r.Facts}}}); err != nil {
		return fmt.Errorf("send agent hello: %w", err)
	}
	type received struct {
		message *agentv1.ConnectResponse
		err     error
	}
	incoming := make(chan received, 1)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			message, err := stream.Recv()
			select {
			case incoming <- received{message, err}:
			case <-streamCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { cancel(); <-stopped }()
	handshake := time.NewTimer(10 * time.Second)
	defer handshake.Stop()
	var interval time.Duration
	select {
	case <-ctx.Done():
		return fmt.Errorf("agent stream cancelled: %w", ctx.Err())
	case <-handshake.C:
		return errors.New("gateway welcome timed out")
	case frame := <-incoming:
		if frame.err != nil {
			return fmt.Errorf("receive agent welcome: %w", frame.err)
		}
		welcome := frame.message.GetWelcome()
		if welcome == nil || welcome.NodeId != bundle.NodeID || welcome.LeaseEpoch != bundle.LeaseEpoch {
			return errIdentity
		}
		if welcome.HeartbeatInterval == nil || welcome.HeartbeatInterval.CheckValid() != nil {
			return errors.New("invalid heartbeat interval")
		}
		interval = welcome.HeartbeatInterval.AsDuration()
		if interval < time.Second || interval > 10*time.Second {
			return errors.New("heartbeat interval outside supported range")
		}
	}
	r.Logger.Info("agent connected", "node_id", bundle.NodeID)
	reports := make(chan *agentv1.StateReport)
	if r.Report != nil {
		done := make(chan struct{})
		go func() {
			defer close(done)
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			r.reportStates(streamCtx, bundle.LeaseEpoch, reports, ticker.C)
		}()
		defer func() { cancel(); <-done }()
	}
	// Action goroutines outlive the session; once it ends their updates are dropped and the
	// control plane learns the journaled outcome from its redelivery with the same key.
	updates := make(chan *agentv1.ActionUpdate, 64)
	ended := make(chan struct{})
	defer close(ended)
	send := func(update *agentv1.ActionUpdate) {
		select {
		case updates <- update:
		case <-ended:
		}
	}
	heartbeat := time.NewTicker(interval)
	defer heartbeat.Stop()
	renewal := time.NewTimer(time.Until(renewAt))
	defer renewal.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("agent stream cancelled: %w", ctx.Err())
		case <-renewal.C:
			return nil
		case <-heartbeat.C:
			if err := stream.Send(&agentv1.ConnectRequest{Msg: &agentv1.ConnectRequest_Heartbeat{Heartbeat: &agentv1.Heartbeat{SentAt: timestamppb.Now(), LeaseEpoch: bundle.LeaseEpoch}}}); err != nil {
				return fmt.Errorf("send heartbeat: %w", err)
			}
		case update := <-updates:
			if err := stream.Send(&agentv1.ConnectRequest{Msg: &agentv1.ConnectRequest_ActionUpdate{ActionUpdate: update}}); err != nil {
				return fmt.Errorf("send action update: %w", err)
			}
		case report := <-reports:
			if err := stream.Send(&agentv1.ConnectRequest{Msg: &agentv1.ConnectRequest_StateReport{StateReport: report}}); err != nil {
				return fmt.Errorf("send state report: %w", err)
			}
		case frame := <-incoming:
			if frame.err != nil {
				return fmt.Errorf("receive agent frame: %w", frame.err)
			}
			if err := r.dispatch(ctx, frame.message, send); err != nil {
				return err
			}
		}
	}
}

// dispatch starts or cancels actions. Routing, peers and leases arrive with their milestones;
// until then the stream refuses them instead of pretending to apply them.
func (r *Runner) dispatch(ctx context.Context, message *agentv1.ConnectResponse, send func(*agentv1.ActionUpdate)) error {
	switch msg := message.GetMsg().(type) {
	case *agentv1.ConnectResponse_ActionRequest:
		if r.Actions != nil {
			r.inflight.Go(func() { r.Actions.Handle(ctx, msg.ActionRequest, send) })
			return nil
		}
	case *agentv1.ConnectResponse_CancelAction:
		if r.Actions != nil {
			r.Actions.Cancel(msg.CancelAction.GetActionId())
			return nil
		}
	}
	return fmt.Errorf("agent stream: %w", status.Error(codes.Unimplemented, "unsupported gateway frame"))
}

func retryDelay(attempt int) time.Duration {
	base := min(time.Second<<min(max(attempt, 0), 5), 30*time.Second)
	jitter, err := rand.Int(rand.Reader, big.NewInt(int64(base/2)))
	if err != nil {
		return base
	}
	return base/2 + time.Duration(jitter.Int64())
}
