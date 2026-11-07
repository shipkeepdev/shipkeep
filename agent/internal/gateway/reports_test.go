package gateway

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	nodecredentials "github.com/samuelmbabhazi/shipkeep/agent/internal/credentials"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

func TestStateReportsRefreshOnChangeAndPeriodicallyWithoutFalseEmptySnapshots(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		current := &agentv1.StateReport{Containers: []*agentv1.ContainerStatus{{Name: "sk-a", State: agentv1.ContainerStatus_STATE_RUNNING}}}
		var failure error
		var mu sync.Mutex
		r := Runner{Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Report: func(context.Context) (*agentv1.StateReport, error) {
			mu.Lock()
			defer mu.Unlock()
			return current, failure
		}}
		output := make(chan *agentv1.StateReport, 4)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		done := make(chan struct{})
		go func() { defer close(done); r.reportStates(ctx, 7, output, ticker.C) }()
		first := <-output
		if first.LeaseEpoch != 7 || first.ObservedAt == nil || current.LeaseEpoch != 0 {
			t.Fatal("epoch/timestamp or snapshot ownership violated")
		}
		time.Sleep(29 * time.Second)
		synctest.Wait()
		if len(output) != 0 {
			t.Fatal("unchanged snapshot sent before refresh interval")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		<-output
		mu.Lock()
		current = &agentv1.StateReport{Containers: []*agentv1.ContainerStatus{{Name: "sk-a", State: agentv1.ContainerStatus_STATE_EXITED}}}
		mu.Unlock()
		time.Sleep(time.Second)
		synctest.Wait()
		if (<-output).Containers[0].State != agentv1.ContainerStatus_STATE_EXITED {
			t.Fatal("manual stop not reported")
		}
		mu.Lock()
		failure = errors.New("daemon unavailable")
		mu.Unlock()
		time.Sleep(31 * time.Second)
		synctest.Wait()
		if len(output) != 0 {
			t.Fatal("daemon failure emitted an inventory")
		}
		mu.Lock()
		failure, current = nil, &agentv1.StateReport{}
		mu.Unlock()
		time.Sleep(time.Second)
		synctest.Wait()
		if len((<-output).Containers) != 0 {
			t.Fatal("removal not reported")
		}
		cancel()
		<-done
	})
}

func TestRunnerTransmitsStateReportsAfterWelcome(t *testing.T) {
	address, server := startGateway(t, true)
	server.reports = make(chan *agentv1.StateReport, 1)
	bundle, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Address: address, StateDir: t.TempDir(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Report: func(context.Context) (*agentv1.StateReport, error) { return &agentv1.StateReport{}, nil }}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx, bundle) }()
	select {
	case report := <-server.reports:
		if report.LeaseEpoch != bundle.LeaseEpoch || report.ObservedAt == nil {
			t.Fatal("stream lost report metadata")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no state report received")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reporter did not stop")
	}
}
