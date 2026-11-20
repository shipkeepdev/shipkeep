package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
)

type routeKeeper struct {
	mu      sync.Mutex
	calls   int
	failFor int
	applied chan int
}

func (r *routeKeeper) EnsureControlPlaneRoutes(context.Context, []caddy.Route) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.calls <= r.failFor {
		return false, errors.New("caddy PUT: status 503")
	}
	r.applied <- r.calls
	return r.calls == r.failFor+1, nil
}

// The route is applied once Caddy answers, then checked again at every interval, without the
// control plane (ADR 0021, architecture rule 10).
func TestTheControlPlaneRouteIsKeptWhileTheAgentRuns(t *testing.T) {
	keeper := &routeKeeper{failFor: 2, applied: make(chan int, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		keepControlPlaneRoute(ctx, keeper, caddy.ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080"), 20*time.Millisecond, time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))
	}()
	deadline := time.After(5 * time.Second)
	for checks := 0; checks < 3; {
		select {
		case <-keeper.applied:
			checks++
		case <-deadline:
			t.Fatal("the route was not checked again at each interval")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the keeper did not stop with its context")
	}
}

type stalledRouter struct{ attempts chan struct{} }

func (s *stalledRouter) EnsureControlPlaneRoutes(ctx context.Context, _ []caddy.Route) (bool, error) {
	<-ctx.Done()
	s.attempts <- struct{}{}
	return false, ctx.Err()
}

// A Caddy that never finishes answering ends each attempt after one interval, so the keeper
// retries instead of holding the route lock while the agent runs.
func TestAStalledAttemptEndsAfterOneInterval(t *testing.T) {
	router := &stalledRouter{attempts: make(chan struct{}, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go keepControlPlaneRoute(ctx, router, caddy.ControlPlaneRoutes("shipkeep.example.com", "127.0.0.1:8080"), 20*time.Millisecond, time.Millisecond, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for range 2 {
		select {
		case <-router.attempts:
		case <-time.After(5 * time.Second):
			t.Fatal("a stalled attempt was not bounded")
		}
	}
}
