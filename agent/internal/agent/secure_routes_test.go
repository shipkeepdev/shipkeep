package agent

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type flakyRouter struct {
	mu       sync.Mutex
	failures int
	calls    int
}

func (f *flakyRouter) SecureRoutes(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.calls <= f.failures {
		return errors.New("caddy GET: dial unix /run/shipkeep/caddy-admin.sock: connect: no such file or directory")
	}
	return nil
}

func TestSecureRoutesRetriesUntilCaddyAnswers(t *testing.T) {
	var logs bytes.Buffer
	router := &flakyRouter{failures: 3}
	secureRoutesUntilDone(t.Context(), router, slog.New(slog.NewJSONHandler(&logs, nil)), time.Millisecond, 2*time.Millisecond)
	if router.calls != 4 {
		t.Fatalf("expected three retries then success, got %d calls", router.calls)
	}
	if strings.Count(logs.String(), "caddy routes not checked yet") != 3 {
		t.Fatalf("each failure should be logged once: %s", logs.String())
	}
}

func TestSecureRoutesStopsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	router := &flakyRouter{failures: 1 << 30}
	done := make(chan struct{})
	go func() {
		defer close(done)
		secureRoutesUntilDone(ctx, router, slog.New(slog.DiscardHandler), time.Hour, time.Hour)
	}()
	for {
		router.mu.Lock()
		calls := router.calls
		router.mu.Unlock()
		if calls > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the retry loop outlived its context")
	}
}
