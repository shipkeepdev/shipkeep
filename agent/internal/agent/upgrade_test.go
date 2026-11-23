package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/upgrade"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// notifications records what the agent tells systemd.
type notifications struct {
	mu   sync.Mutex
	sent []string
}

func (n *notifications) notify(state string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = append(n.sent, state)
	return nil
}

func (n *notifications) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.sent)
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func record(t *testing.T, stateDir string, from, to, state string) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "shipkeep-agent")
	if err := upgrade.WritePending(stateDir, upgrade.Pending{From: from, To: to, Binary: binary, SHA256: "aa", At: time.Unix(1, 0).UTC(), State: state}); err != nil {
		t.Fatal(err)
	}
}

func pending(t *testing.T, stateDir string) bool {
	t.Helper()
	_, found, err := upgrade.ReadPending(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestANormalStartIsReadyWithoutTheControlPlane(t *testing.T) {
	sent := &notifications{}
	boot := newStartup(t.TempDir(), "0.2.0", quiet(), sent.notify)
	boot.started()
	if sent.count() != 1 || sent.sent[0] != "READY=1" {
		t.Fatalf("notified %v", sent.sent)
	}
	boot.connected()
	if sent.count() != 1 {
		t.Fatal("notified again when connected")
	}
	if err := boot.deadline(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("a normal start has a deadline: %v", err)
	}
}

func TestAnUpgradedBinaryIsReadyOnlyOnceTheControlPlaneWelcomedIt(t *testing.T) {
	stateDir := t.TempDir()
	record(t, stateDir, "0.1.0", "0.2.0", upgrade.StatePending)
	sent := &notifications{}
	boot := newStartup(stateDir, "0.2.0", quiet(), sent.notify)
	boot.started()
	if sent.count() != 0 {
		t.Fatal("ready before the control plane welcomed the upgraded binary")
	}
	done := make(chan error, 1)
	go func() { done <- boot.deadline(context.Background(), time.Minute) }()
	boot.connected()
	boot.connected()
	if err := <-done; err != nil {
		t.Fatalf("confirmed upgrade still timed out: %v", err)
	}
	if sent.count() != 1 || pending(t, stateDir) {
		t.Fatalf("notified %v, record still there: %v", sent.sent, pending(t, stateDir))
	}
}

func TestAnUpgradedBinaryThatNeverConnectsGivesUp(t *testing.T) {
	stateDir := t.TempDir()
	record(t, stateDir, "0.1.0", "0.2.0", upgrade.StatePending)
	sent := &notifications{}
	boot := newStartup(stateDir, "0.2.0", quiet(), sent.notify)
	boot.started()
	if err := boot.deadline(context.Background(), 10*time.Millisecond); !errors.Is(err, ErrUpgradeUnconfirmed) {
		t.Fatalf("deadline: %v", err)
	}
	if sent.count() != 0 || !pending(t, stateDir) {
		t.Fatal("an unconfirmed upgrade was reported ready or forgotten")
	}
}

func TestThePreviousBinaryReportsARollbackAndForgetsIt(t *testing.T) {
	for _, state := range []string{upgrade.StateRolledBack, upgrade.StatePending} {
		stateDir := t.TempDir()
		record(t, stateDir, "0.1.0", "0.2.0", state)
		sent := &notifications{}
		boot := newStartup(stateDir, "0.1.0", quiet(), sent.notify)
		boot.started()
		if sent.count() != 1 || pending(t, stateDir) {
			t.Fatalf("%s: notified %v, record kept: %v", state, sent.sent, pending(t, stateDir))
		}
	}
	// A record of other versions is stale.
	stateDir := t.TempDir()
	record(t, stateDir, "0.0.9", "0.1.0", upgrade.StatePending)
	newStartup(stateDir, "0.3.0", quiet(), (&notifications{}).notify)
	if pending(t, stateDir) {
		t.Fatal("a stale record was kept")
	}
}

func TestTheAgentRestartsOnceTheUpgradeResultIsSent(t *testing.T) {
	restart := newRestarter()
	done := make(chan error, 1)
	go func() { done <- restart.wait(context.Background(), time.Minute) }()
	succeeded := func(id string) *agentv1.ActionUpdate {
		return &agentv1.ActionUpdate{ActionId: id, State: agentv1.OperationState_OPERATION_STATE_SUCCEEDED}
	}
	restart.delivered(succeeded("upgrade"))
	restart.request("upgrade")
	restart.delivered(&agentv1.ActionUpdate{ActionId: "upgrade", State: agentv1.OperationState_OPERATION_STATE_RUNNING})
	restart.delivered(succeeded("another"))
	select {
	case err := <-done:
		t.Fatalf("restarted before the result was sent: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	restart.delivered(succeeded("upgrade"))
	if err := <-done; !errors.Is(err, errRestart) {
		t.Fatalf("wait: %v", err)
	}
}

func TestTheAgentRestartsWhenTheResultCannotBeSent(t *testing.T) {
	restart := newRestarter()
	restart.request("upgrade")
	if err := restart.wait(context.Background(), 10*time.Millisecond); !errors.Is(err, errRestart) {
		t.Fatalf("wait: %v", err)
	}
	// Without a request, a shutdown ends the wait with nothing to do.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := newRestarter().wait(ctx, time.Minute); err != nil {
		t.Fatalf("wait: %v", err)
	}
}
