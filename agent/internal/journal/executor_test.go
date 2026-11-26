package journal

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

func TestRecoveryAfterEveryStepSideEffect(t *testing.T) {
	for _, retrySafe := range []bool{true, false} {
		for crashAt := 0; crashAt < 3; crashAt++ {
			t.Run(fmt.Sprintf("retry-safe-%t-step-%d", retrySafe, crashAt), func(t *testing.T) {
				dir := t.TempDir()
				store, err := Open(t.Context(), dir)
				if err != nil {
					t.Fatal(err)
				}
				applied := [3]bool{}
				calls := [3]int{}
				crashed := false
				var undoOrder []int
				plan := Plan{Version: "v1"}
				for index := range 3 {
					plan.Steps = append(plan.Steps, Step{Name: fmt.Sprintf("step_%d", index), RetrySafe: retrySafe,
						Apply: func(context.Context) (Outcome, error) {
							applied[index] = true
							calls[index]++
							if index == crashAt && !crashed {
								crashed = true
								if err := store.Close(); err != nil {
									t.Fatal(err)
								}
							}
							return Outcome{ResourceID: "resource"}, nil
						},
						Compensate: func(context.Context) error { applied[index] = false; undoOrder = append(undoOrder, index); return nil },
					})
				}
				if _, err := store.Execute(t.Context(), request(), plan, nil); err == nil {
					t.Fatal("simulated crash did not interrupt checkpoint")
				}
				store, err = Open(t.Context(), dir)
				if err != nil {
					t.Fatal(err)
				}
				defer store.Close() //nolint:errcheck // test cleanup
				result, err := store.Execute(t.Context(), request(), plan, nil)
				if retrySafe {
					if err != nil || result.State != Succeeded || applied != [3]bool{true, true, true} || calls[crashAt] != 2 {
						t.Fatalf("idempotent resume failed: %v", err)
					}
					before := calls
					cached, err := store.Execute(t.Context(), request(), plan, nil)
					if err != nil || cached.Result != result.Result || calls != before {
						t.Fatal("completed replay executed again")
					}
				} else {
					if !errors.Is(err, ErrOperationFailed) || result.State != Compensated || applied != [3]bool{} {
						t.Fatal("unsafe step was resumed instead of compensated")
					}
					for position, index := range undoOrder {
						if index != crashAt-position {
							t.Fatal("compensation order is not reverse execution order")
						}
					}
				}
			})
		}
	}
}

func TestCompensationResumesAfterItsOwnCrash(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	undos := 0
	plan := Plan{Version: "v1", Steps: []Step{{Name: "create", RetrySafe: false, Apply: func(context.Context) (Outcome, error) { return Outcome{}, errors.New("private application error") }, Compensate: func(context.Context) error {
		undos++
		if undos == 1 {
			return store.Close()
		}
		return nil
	}}}}
	if _, err := store.Execute(t.Context(), request(), plan, nil); err == nil {
		t.Fatal("compensation crash ignored")
	}
	store, err = Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	result, err := store.Execute(t.Context(), request(), plan, nil)
	if !errors.Is(err, ErrOperationFailed) || result.State != Compensated || undos != 2 {
		t.Fatal("compensation was not safely retried")
	}
}

func TestPlanChangesAndNotificationFailureCannotSkipWork(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	calls := 0
	updates := []State{}
	plan := Plan{Version: "v1", Steps: []Step{{Name: "create", RetrySafe: true, Apply: func(context.Context) (Outcome, error) { calls++; return Outcome{ResourceID: "resource"}, nil }, Compensate: func(context.Context) error { return nil }}}}
	if _, err := store.Execute(t.Context(), request(), plan, func(context.Context, Operation) error { return errors.New("offline") }); err == nil || calls != 0 {
		t.Fatal("executed before pending notification")
	}
	result, err := store.Execute(t.Context(), request(), plan, func(_ context.Context, op Operation) error { updates = append(updates, op.State); return nil })
	if err != nil || result.State != Succeeded || calls != 1 || updates[0] != Pending || updates[len(updates)-1] != Succeeded {
		t.Fatal("transition delivery lost intent or completion")
	}
	plan.Version = "v2"
	if _, err := store.Execute(t.Context(), request(), plan, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("reused key with a changed execution plan")
	}
}

func TestConcurrentExecutionReplaysOneStoredOutcome(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	calls := 0
	plan := Plan{Version: "v1", Steps: []Step{{Name: "create", RetrySafe: true, Apply: func(context.Context) (Outcome, error) { calls++; return Outcome{ResourceID: "resource"}, nil }, Compensate: func(context.Context) error { return nil }}}}
	var workers sync.WaitGroup
	for range 10 {
		workers.Go(func() {
			op, err := store.Execute(t.Context(), request(), plan, nil)
			if err != nil || op.Result.ResourceID != "resource" {
				t.Error("concurrent replay failed")
			}
		})
	}
	workers.Wait()
	if calls != 1 {
		t.Fatal("concurrent callers executed side effects twice")
	}
}

func TestCancellationRetainsRecoverableIntent(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	plan := Plan{Version: "v1", Steps: []Step{{Name: "create", RetrySafe: true, Apply: func(context.Context) (Outcome, error) { cancel(); return Outcome{}, context.Canceled }, Compensate: func(context.Context) error { return nil }}}}
	op, err := store.Execute(ctx, request(), plan, nil)
	if !errors.Is(err, context.Canceled) || op.State != Running {
		t.Fatal("shutdown discarded recoverable intent")
	}
	pending, err := store.Unfinished(t.Context())
	if err != nil || len(pending) != 1 || pending[0].Step != "create" {
		t.Fatal("interrupted step not persisted")
	}
}

func TestNotificationFailureAtStepStartDoesNotCompensate(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	applied, compensated := 0, 0
	plan := Plan{Version: "v1", Steps: []Step{{
		Name:       "create",
		RetrySafe:  false,
		Apply:      func(context.Context) (Outcome, error) { applied++; return Outcome{ResourceID: "resource"}, nil },
		Compensate: func(context.Context) error { compensated++; return nil },
	}}}
	// The stream drops exactly when the step-start checkpoint is announced.
	dropStepStart := func(_ context.Context, op Operation) error {
		if op.Step != "" {
			return errors.New("offline")
		}
		return nil
	}
	if _, err := store.Execute(t.Context(), request(), plan, dropStepStart); err == nil || applied != 0 {
		t.Fatal("step ran although its start could not be announced")
	}
	pending, err := store.Unfinished(t.Context())
	if err != nil || len(pending) != 1 || pending[0].Step != "" {
		t.Fatal("step marker left behind for a step that never ran")
	}
	op, err := store.Execute(t.Context(), request(), plan, nil)
	if err != nil || op.State != Succeeded || applied != 1 || compensated != 0 {
		t.Fatalf("delivery failure triggered compensation: state=%v applied=%d compensated=%d err=%v", op.State, applied, compensated, err)
	}
}

func TestShutdownDuringSuccessfulStepRecordsTheSuccess(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	applied, compensated := 0, 0
	plan := Plan{Version: "v1", Steps: []Step{{
		Name:      "create",
		RetrySafe: false,
		Apply: func(context.Context) (Outcome, error) {
			applied++
			cancel() // SIGTERM arrives while the side effect completes.
			return Outcome{ResourceID: "resource"}, nil
		},
		Compensate: func(context.Context) error { compensated++; return nil },
	}}}
	if _, err := store.Execute(ctx, request(), plan, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("Execute() error = %v, want cancellation", err)
	}
	op, err := store.Execute(t.Context(), request(), plan, nil)
	if err != nil || op.State != Succeeded || op.Result.ResourceID != "resource" || applied != 1 || compensated != 0 {
		t.Fatalf("completed step was compensated after shutdown: state=%v applied=%d compensated=%d err=%v", op.State, applied, compensated, err)
	}
}

func TestCompensationGivesUpAfterBoundedAttempts(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	plan := Plan{Version: "v1", Steps: []Step{{
		Name:       "create",
		Apply:      func(context.Context) (Outcome, error) { return Outcome{}, errors.New("docker refused") },
		Compensate: func(context.Context) error { return errors.New("still broken") },
	}}}
	var last error
	for range maxCompensationAttempts + 2 {
		_, last = store.Execute(t.Context(), request(), plan, nil)
		if errors.Is(last, ErrOperationFailed) {
			break
		}
	}
	if !errors.Is(last, ErrOperationFailed) {
		t.Fatalf("compensation retried without bound: last error %v", last)
	}
	pending, err := store.Unfinished(t.Context())
	if err != nil || len(pending) != 0 {
		t.Fatal("terminally failed operation still resumes on every boot")
	}
}

type causedError struct{ cause string }

func (e causedError) Error() string { return "step failed for a reason the journal must not keep" }
func (e causedError) Cause() string { return e.cause }

// A step that fails can name its cause with a short code. The journal keeps the code, not the
// error text, through compensation, a replay and a restart.
func TestFailedStepKeepsItsCauseThroughCompensationAndReplay(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	plan := Plan{Version: "v1", Steps: []Step{
		{Name: "prepare", RetrySafe: true, Apply: func(context.Context) (Outcome, error) { return Outcome{}, nil }, Compensate: func(context.Context) error { return nil }},
		{Name: "pull", RetrySafe: true, Apply: func(context.Context) (Outcome, error) {
			return Outcome{}, fmt.Errorf("pull image: %w", causedError{cause: "registry_denied"})
		}, Compensate: func(context.Context) error { return nil }},
	}}
	var seen []Operation
	result, err := store.Execute(t.Context(), request(), plan, func(_ context.Context, op Operation) error { seen = append(seen, op); return nil })
	if !errors.Is(err, ErrOperationFailed) || result.State != Compensated || result.Cause != "registry_denied" {
		t.Fatalf("got %+v, %v", result, err)
	}
	for _, op := range seen {
		if (op.State == Compensating || op.State == Compensated) && op.Cause != "registry_denied" {
			t.Fatalf("cause lost at %s: %+v", op.State, op)
		}
		if op.State == Running && op.Cause != "" {
			t.Fatalf("cause before any failure: %+v", op)
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	// After a restart the same request replays the stored outcome, cause included.
	store, err = Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	replayed, err := store.Execute(t.Context(), request(), plan, nil)
	if !errors.Is(err, ErrOperationFailed) || replayed.Cause != "registry_denied" {
		t.Fatalf("replay lost the cause: %+v, %v", replayed, err)
	}
}

// A cause is a code, never a text: what does not look like one is dropped.
func TestCauseThatIsNotACodeIsDropped(t *testing.T) {
	for _, cause := range []string{"", "Registry Denied", "registry-denied", "x' OR 1=1 --", "password=sk_test_fake", strings.Repeat("a", 33), "step_failed", "9lives", "été"} {
		store, err := Open(t.Context(), t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		plan := Plan{Version: "v1", Steps: []Step{{Name: "only", RetrySafe: true,
			Apply:      func(context.Context) (Outcome, error) { return Outcome{}, causedError{cause: cause} },
			Compensate: func(context.Context) error { return nil }}}}
		result, err := store.Execute(t.Context(), request(), plan, nil)
		if !errors.Is(err, ErrOperationFailed) || result.State != Compensated || result.Cause != "" {
			t.Fatalf("%q kept as %q (%v)", cause, result.Cause, err)
		}
		_ = store.Close()
	}
}

// Issue #484: past its deadline, an operation is only ended, never carried forward. The steps it
// applied, the one in progress included, are undone; one never started is cancelled; none is
// recorded for a request the journal never saw.
func TestRecoverUndoesWithoutAnyForwardEffect(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	var applied, undone []string
	step := func(name string, retrySafe bool, interrupt func()) Step {
		return Step{
			Name: name, RetrySafe: retrySafe,
			Apply: func(context.Context) (Outcome, error) {
				applied = append(applied, name)
				if interrupt != nil {
					interrupt()
					return Outcome{}, context.DeadlineExceeded
				}
				return Outcome{}, nil
			},
			Compensate: func(context.Context) error {
				undone = append(undone, name)
				return nil
			},
		}
	}
	// Never seen: nothing is recorded, nothing runs.
	plan := Plan{Version: "v1", Steps: []Step{step("create", true, nil)}}
	if _, err := store.Recover(t.Context(), request(), plan, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("recovered an operation the journal never saw: %v", err)
	}
	if pending, _ := store.Unfinished(t.Context()); len(pending) != 0 || len(applied) != 0 {
		t.Fatal("recovery recorded or ran something")
	}
	// The deadline ends the second step while it runs, though it is retry-safe.
	ctx, cancel := context.WithCancel(t.Context())
	interrupted := Plan{Version: "v1", Steps: []Step{
		step("network", true, nil),
		step("create", true, cancel),
		step("start", true, nil),
	}}
	if op, err := store.Execute(ctx, request(), interrupted, nil); err == nil || op.State != Running {
		t.Fatalf("the interrupted operation is not left running: %v %v", op.State, err)
	}
	applied = nil
	op, err := store.Recover(t.Context(), request(), interrupted, nil)
	if !errors.Is(err, ErrOperationFailed) || op.State != Compensated {
		t.Fatalf("recovery did not compensate: %v %v", op.State, err)
	}
	if len(applied) != 0 || fmt.Sprint(undone) != "[create network]" {
		t.Fatalf("recovery applied %v and undid %v", applied, undone)
	}
	// Once ended, a later recovery returns the outcome as it is.
	undone = nil
	again, err := store.Recover(t.Context(), request(), interrupted, nil)
	if !errors.Is(err, ErrOperationFailed) || again.State != Compensated || len(undone) != 0 {
		t.Fatalf("a finished operation was recovered again: %v %v %v", again.State, err, undone)
	}
}

func TestRecoverCancelsAnOperationThatNeverStarted(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	ran := false
	plan := Plan{Version: "v1", Steps: []Step{{
		Name: "create", RetrySafe: true,
		Apply:      func(context.Context) (Outcome, error) { ran = true; return Outcome{}, nil },
		Compensate: func(context.Context) error { ran = true; return nil },
	}}}
	// Intent recorded, then the process stopped before any step.
	if _, err := store.Begin(t.Context(), func() Request { r := request(); r.PayloadHash = planHash(r.PayloadHash, plan); return r }()); err != nil {
		t.Fatal(err)
	}
	op, err := store.Recover(t.Context(), request(), plan, nil)
	if !errors.Is(err, ErrOperationFailed) || op.State != Cancelled || ran {
		t.Fatalf("an operation that never started was not cancelled cleanly: %v %v %v", op.State, err, ran)
	}
}
