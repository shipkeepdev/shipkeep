package gateway

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	nodecredentials "github.com/samuelmbabhazi/shipkeep/agent/internal/credentials"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

var errIdentity = errors.New("gateway rejected the node identity or epoch; operator recovery is required")

// Runner owns one outbound stream and its reconnect/renewal lifecycle.
type Runner struct {
	Address  string
	StateDir string
	Version  string
	Facts    *agentv1.NodeFacts
	Logger   *slog.Logger
}

// Run preserves local credentials during outages and never silently re-enrolls a rejected node.
func (r Runner) Run(ctx context.Context, bundle nodecredentials.Bundle) error {
	attempt := 0
	for ctx.Err() == nil {
		started := time.Now()
		updated, err := r.cycle(ctx, bundle)
		if ctx.Err() != nil {
			return nil //nolint:nilerr // Parent cancellation is a clean shutdown, not a failed connection.
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

func (r Runner) cycle(ctx context.Context, bundle nodecredentials.Bundle) (nodecredentials.Bundle, error) {
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
	renewed, err := Renew(ctx, client, bundle)
	if err != nil {
		return bundle, err
	}
	if err := renewed.Save(r.StateDir); err != nil {
		// Renewal already revoked the old certificate. Never reconnect using it after a failed save.
		return bundle, errIdentity
	}
	r.Logger.Info("agent certificate renewed")
	return renewed, nil
}

func (r Runner) session(ctx context.Context, client agentv1.AgentGatewayServiceClient, bundle nodecredentials.Bundle, renewAt time.Time) error {
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
		case frame := <-incoming:
			if frame.err != nil {
				return fmt.Errorf("receive agent frame: %w", frame.err)
			}
			// Actions and lease fencing require their journal/handler milestones. Never pretend execution.
			return fmt.Errorf("agent stream: %w", status.Error(codes.Unimplemented, "unsupported gateway frame"))
		}
	}
}

func retryDelay(attempt int) time.Duration {
	base := min(time.Second<<min(max(attempt, 0), 5), 30*time.Second)
	jitter, err := rand.Int(rand.Reader, big.NewInt(int64(base/2)))
	if err != nil {
		return base
	}
	return base/2 + time.Duration(jitter.Int64())
}
