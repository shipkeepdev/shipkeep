package actions

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const testID = "019d0000-0000-7000-8000-00000000000a"

type recorder struct {
	mu      sync.Mutex
	updates []*agentv1.ActionUpdate
}

func (r *recorder) send(update *agentv1.ActionUpdate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.updates = append(r.updates, update)
}

func (r *recorder) last(t *testing.T) *agentv1.ActionUpdate {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.updates) == 0 {
		t.Fatal("no update sent")
	}
	return r.updates[len(r.updates)-1]
}

func open(t *testing.T) *journal.Store {
	t.Helper()
	store, err := journal.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func request(name string) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{
		ActionId:       testID,
		IdempotencyKey: "deploy:42:network",
		DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
		LeaseEpoch:     3,
		Action:         &agentv1.ActionRequest_EnsureNetwork{EnsureNetwork: &agentv1.EnsureNetwork{Name: name}},
	}
}

func dispatcher(store Executor, applied *atomic.Int32, apply func(context.Context) (journal.Outcome, error)) *Dispatcher {
	if apply == nil {
		apply = func(context.Context) (journal.Outcome, error) { //nolint:unparam // matches journal.Step.Apply
			applied.Add(1)
			return journal.Outcome{ResourceID: "net-1"}, nil
		}
	}
	return &Dispatcher{
		Journal: store,
		Epoch:   func() uint64 { return 3 },
		Handlers: map[string]Handler{"ensure_network": {
			Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
				if !strings.HasPrefix(req.GetEnsureNetwork().GetName(), "sk-") {
					return journal.Plan{}, errors.New("invalid name")
				}
				return journal.Plan{Version: "ensure-network-v1", Steps: []journal.Step{{
					Name: "create", RetrySafe: true, Apply: apply,
					Compensate: func(context.Context) error { return nil },
				}}}, nil
			},
			Result: func(outcome journal.Outcome) *agentv1.ActionResult {
				return &agentv1.ActionResult{Result: &agentv1.ActionResult_ContainerId{ContainerId: outcome.ResourceID}}
			},
		}},
	}
}

func TestDispatcherRunsJournaledActionsOnce(t *testing.T) {
	store := open(t)
	var applied atomic.Int32
	d := dispatcher(store, &applied, nil)
	first := &recorder{}
	d.Handle(context.Background(), request("sk-app"), first.send)
	final := first.last(t)
	if final.GetState() != agentv1.OperationState_OPERATION_STATE_SUCCEEDED || final.GetResult().GetContainerId() != "net-1" {
		t.Fatalf("unexpected final update: %v", final)
	}
	if len(first.updates) < 2 {
		t.Fatalf("expected progress updates, got %d", len(first.updates))
	}
	// Redelivery with the same key replays the journaled outcome without running the step again.
	replay := &recorder{}
	d.Handle(context.Background(), request("sk-app"), replay.send)
	if replay.last(t).GetState() != agentv1.OperationState_OPERATION_STATE_SUCCEEDED || applied.Load() != 1 {
		t.Fatalf("replay re-executed the action: applied=%d", applied.Load())
	}
	// The same key for a different payload is refused.
	conflict := &recorder{}
	d.Handle(context.Background(), request("sk-other"), conflict.send)
	if got := conflict.last(t); got.GetState() != agentv1.OperationState_OPERATION_STATE_FAILED || got.GetError() != errConflict {
		t.Fatalf("conflict not reported: %v", got)
	}
}

func TestDispatcherRejectsBeforeJournaling(t *testing.T) {
	var applied atomic.Int32
	cases := map[string]func(*agentv1.ActionRequest){
		"id injection":  func(r *agentv1.ActionRequest) { r.ActionId = testID + "'; DROP TABLE operations;--" },
		"empty id":      func(r *agentv1.ActionRequest) { r.ActionId = "" },
		"key traversal": func(r *agentv1.ActionRequest) { r.IdempotencyKey = "../../etc/passwd" },
		"oversized key": func(r *agentv1.ActionRequest) { r.IdempotencyKey = strings.Repeat("k", 129) },
		"no action":     func(r *agentv1.ActionRequest) { r.Action = nil },
		"unhandled kind": func(r *agentv1.ActionRequest) {
			r.Action = &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{}}
		},
		"stale epoch":     func(r *agentv1.ActionRequest) { r.LeaseEpoch = 2 },
		"expired":         func(r *agentv1.ActionRequest) { r.DeadlineUnixMs = time.Now().Add(-time.Second).UnixMilli() },
		"no deadline":     func(r *agentv1.ActionRequest) { r.DeadlineUnixMs = 0 },
		"invalid payload": func(r *agentv1.ActionRequest) { r.GetEnsureNetwork().Name = "host" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			store := open(t)
			req := request("sk-app")
			mutate(req)
			out := &recorder{}
			dispatcher(store, &applied, nil).Handle(context.Background(), req, out.send)
			got := out.last(t)
			if got.GetState() != agentv1.OperationState_OPERATION_STATE_FAILED || len(out.updates) != 1 {
				t.Fatalf("expected one failure, got %v", out.updates)
			}
			for _, leaked := range []string{"DROP", "passwd", "host", strings.Repeat("k", 20)} {
				if strings.Contains(got.GetError(), leaked) {
					t.Fatalf("error echoes request content: %q", got.GetError())
				}
			}
			unfinished, err := store.Unfinished(context.Background())
			if err != nil || len(unfinished) != 0 {
				t.Fatalf("rejected request was journaled: %v %v", unfinished, err)
			}
		})
	}
	if applied.Load() != 0 {
		t.Fatal("a rejected request ran a step")
	}
}

func TestDispatcherCancelsRunningActions(t *testing.T) {
	store := open(t)
	started := make(chan struct{})
	d := dispatcher(store, nil, func(ctx context.Context) (journal.Outcome, error) {
		close(started)
		<-ctx.Done()
		return journal.Outcome{}, ctx.Err()
	})
	out := &recorder{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		d.Handle(context.Background(), request("sk-app"), out.send)
	}()
	<-started
	if !d.Cancel(testID) {
		t.Fatal("running action was not cancellable")
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled action did not stop")
	}
	if out.last(t).GetState() == agentv1.OperationState_OPERATION_STATE_SUCCEEDED {
		t.Fatal("cancelled action reported success")
	}
	if d.Cancel(testID) {
		t.Fatal("finished action is still tracked")
	}
}
