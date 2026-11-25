package gateway

import (
	"context"
	"errors"
	"fmt"
	"sync"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// errNoSession is returned between sessions: an RPC beside Connect needs the session's connection.
var errNoSession = errors.New("no gateway session")

// Streams opens the RPCs that run beside Connect, on the connection of the current session:
// ExecStream for an exec session (SPEC 3.1). The gateway authenticates each one as it does
// Connect. A stream ends with the session's connection, so a reconnection ends it too.
type Streams struct {
	mu     sync.Mutex
	client agentv1.AgentGatewayServiceClient
}

func (s *Streams) use(client agentv1.AgentGatewayServiceClient) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.client = client
}

// OpenExec opens an ExecStream. ctx bounds the stream: cancelling it ends the stream.
func (s *Streams) OpenExec(ctx context.Context) (agentv1.AgentGatewayService_ExecStreamClient, error) {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	if client == nil {
		return nil, errNoSession
	}
	stream, err := client.ExecStream(ctx)
	if err != nil {
		return nil, fmt.Errorf("open exec stream: %w", err)
	}
	return stream, nil
}

// OpenLogs opens a ShipLogs stream (ADR 0029). ctx bounds the stream: cancelling it ends the stream.
func (s *Streams) OpenLogs(ctx context.Context) (agentv1.AgentGatewayService_ShipLogsClient, error) {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	if client == nil {
		return nil, errNoSession
	}
	stream, err := client.ShipLogs(ctx)
	if err != nil {
		return nil, fmt.Errorf("open log stream: %w", err)
	}
	return stream, nil
}
