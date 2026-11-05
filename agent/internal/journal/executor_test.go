package journal

import (
	"context"
	"errors"
	"fmt"
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
