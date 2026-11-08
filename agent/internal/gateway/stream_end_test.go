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

	nodecredentials "github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

type streamClient struct {
	agentv1.AgentGatewayServiceClient
	stream *endingStream
}

func (c streamClient) Connect(context.Context, ...grpc.CallOption) (grpc.BidiStreamingClient[agentv1.ConnectRequest, agentv1.ConnectResponse], error) {
	return c.stream, nil
}

// endingStream behaves like gRPC once the gateway has ended the stream: Send reports only io.EOF
// and the reason is available from Recv.
type endingStream struct {
	grpc.BidiStreamingClient[agentv1.ConnectRequest, agentv1.ConnectResponse]
	sendsBeforeEOF int
	frames         chan *agentv1.ConnectResponse
	end            chan error
}

func (s *endingStream) Send(*agentv1.ConnectRequest) error {
	if s.sendsBeforeEOF == 0 {
		select {
		case s.end <- status.Error(codes.Unauthenticated, "private revoked credential detail"):
		default:
		}
		return io.EOF
	}
	s.sendsBeforeEOF--
	return nil
}

func (s *endingStream) Recv() (*agentv1.ConnectResponse, error) {
	select {
	case frame := <-s.frames:
		return frame, nil
	case err := <-s.end:
		return nil, err
	}
}

func newEndingStream(sendsBeforeEOF int) *endingStream {
	return &endingStream{sendsBeforeEOF: sendsBeforeEOF, frames: make(chan *agentv1.ConnectResponse, 1), end: make(chan error, 1)}
}

func runEndingSession(t *testing.T, stream *endingStream) error {
	t.Helper()
	runner := Runner{Logger: slog.New(slog.DiscardHandler)}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	bundle := nodecredentials.Bundle{NodeID: testNode, LeaseEpoch: 1}
	return runner.session(ctx, streamClient{stream: stream}, bundle, time.Now().Add(time.Hour))
}

// A refused agent must stop retrying, so the refusal cannot be lost behind the send's io.EOF.
func TestSessionKeepsRejectionWhenHelloFindsTheStreamClosed(t *testing.T) {
	if err := runEndingSession(t, newEndingStream(0)); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("rejection code lost: %v", err)
	}
}

func TestSessionKeepsRejectionWhenHeartbeatFindsTheStreamClosed(t *testing.T) {
	stream := newEndingStream(1)
	stream.frames <- &agentv1.ConnectResponse{Msg: &agentv1.ConnectResponse_Welcome{Welcome: &agentv1.Welcome{NodeId: testNode, LeaseEpoch: 1, HeartbeatInterval: durationpb.New(time.Second)}}}
	if err := runEndingSession(t, stream); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("rejection code lost: %v", err)
	}
}
