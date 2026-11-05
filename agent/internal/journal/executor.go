package journal

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"
)

// ErrOperationFailed indicates an operation that failed and has been compensated or terminated.
var ErrOperationFailed = errors.New("operation failed")

const (
	// checkpointTimeout bounds a journal write that must finish even during shutdown.
	checkpointTimeout = 10 * time.Second
	// maxCompensationAttempts stops retrying a compensator that keeps failing: the operation becomes
	// Failed (terminal, last_error recorded) for an operator instead of being retried on every boot.
	maxCompensationAttempts = 5
)

// Step declares recovery policy before execution. Compensate must be idempotent even when Apply
// never ran or only partially completed. RetrySafe permits repeating Apply after an uncertain crash.
type Step struct {
	Name       string
	RetrySafe  bool
	Apply      func(context.Context) (Outcome, error)
	Compensate func(context.Context) error
}

// Plan is versioned code, never supplied by the network. Changing semantics requires a new Version.
type Plan struct {
	Version string
	Steps   []Step
}

// Notify receives committed transitions for ActionUpdate delivery; errors pause further execution.
type Notify func(context.Context, Operation) error

// Execute records intent, executes/resumes a plan, or compensates an uncertain non-idempotent step.
// The caller reconstructs the same plan/inputs from desired state or a replay; no payload is stored.
func (s *Store) Execute(ctx context.Context, request Request, plan Plan, notify Notify) (Operation, error) {
	if !identifier.MatchString(plan.Version) || len(plan.Steps) == 0 || len(plan.Steps) > 64 {
		return Operation{}, errors.New("invalid operation plan")
	}
	names := map[string]bool{}
	for _, step := range plan.Steps {
		if !stepName.MatchString(step.Name) || names[step.Name] || step.Apply == nil || step.Compensate == nil {
			return Operation{}, errors.New("invalid operation step")
		}
		names[step.Name] = true
	}
	select {
	case s.executing <- struct{}{}:
		defer func() { <-s.executing }()
	case <-ctx.Done():
		return Operation{}, fmt.Errorf("wait for executor: %w", ctx.Err())
	}
	request.PayloadHash = planHash(request.PayloadHash, plan)
	op, err := s.Begin(ctx, request)
	if err != nil {
		return Operation{}, err
	}
	emit := func() error {
		if notify != nil {
			if err := notify(ctx, op); err != nil {
				return errors.New("operation update delivery failed")
			}
		}
		return nil
	}
	if err := emit(); err != nil {
		return op, err
	}
	switch op.State {
	case Succeeded:
		return op, nil
	case Failed, Cancelled, Compensated:
		return op, ErrOperationFailed
	case Pending, Running, Compensating:
	default:
		return op, ErrConflict
	}
	if op.Completed > len(plan.Steps) || (op.State == Running && op.Step != "" && (op.Completed == len(plan.Steps) || op.Step != plan.Steps[op.Completed].Name)) {
		return op, ErrConflict
	}
	// Journal writes use a context that survives cancellation: once a side effect happened, its
	// outcome must be recorded even if shutdown was signalled meanwhile.
	advance := func(next Operation) error {
		durable, cancel := context.WithTimeout(context.WithoutCancel(ctx), checkpointTimeout)
		defer cancel()
		recorded, err := s.Advance(durable, op, next)
		if err != nil {
			return err
		}
		op = recorded
		return nil
	}
	checkpoint := func(next Operation) error {
		if err := advance(next); err != nil {
			return err
		}
		return emit()
	}
	interrupted := func() error { return fmt.Errorf("operation interrupted: %w", ctx.Err()) }
	next := op
	next.Attempts++
	if op.State == Pending {
		next.State = Running
	}
	if op.State == Running && op.Step != "" && !plan.Steps[op.Completed].RetrySafe {
		next.State = Compensating
		next.Completed++ // Include the uncertain in-progress side effect.
	}
	if err := checkpoint(next); err != nil {
		return op, err
	}
	if op.State != Compensating {
		for index := op.Completed; index < len(plan.Steps); index++ {
			step := plan.Steps[index]
			next = op
			next.Step = step.Name
			if err := advance(next); err != nil {
				return op, err
			}
			if err := emit(); err != nil {
				// Apply has not run. Clear the marker so a retry does not compensate a step that
				// never started; a crash before this write still leaves it uncertain, as it must.
				cleared := op
				cleared.Step = ""
				_ = advance(cleared)
				return op, err
			}
			result, applyErr := step.Apply(ctx)
			if applyErr != nil && ctx.Err() != nil {
				return op, interrupted()
			}
			if applyErr != nil {
				next = op
				next.State = Compensating
				next.Completed = index + 1
				if err := checkpoint(next); err != nil {
					return op, err
				}
				break
			}
			next = op
			next.Completed = index + 1
			next.Step = ""
			if result != (Outcome{}) {
				next.Result = result
			}
			if err := checkpoint(next); err != nil {
				return op, err
			}
			if ctx.Err() != nil {
				return op, interrupted()
			}
		}
	}
	if op.State == Compensating {
		for op.Completed > 0 {
			index := op.Completed - 1
			next = op
			next.Step = plan.Steps[index].Name
			if err := checkpoint(next); err != nil {
				return op, err
			}
			if err := plan.Steps[index].Compensate(ctx); err != nil {
				if ctx.Err() != nil {
					return op, interrupted()
				}
				if op.Attempts >= maxCompensationAttempts {
					next = op
					next.State = Failed
					next.Step = ""
					if err := checkpoint(next); err != nil {
						return op, err
					}
					return op, ErrOperationFailed
				}
				return op, errors.New("operation compensation requires retry")
			}
			next = op
			next.Completed = index
			next.Step = ""
			if err := checkpoint(next); err != nil {
				return op, err
			}
		}
		next = op
		next.State = Compensated
		next.Result = Outcome{}
		if err := checkpoint(next); err != nil {
			return op, err
		}
		return op, ErrOperationFailed
	}
	next = op
	next.State = Succeeded
	next.Step = ""
	if err := checkpoint(next); err != nil {
		return op, err
	}
	return op, nil
}

func planHash(payload [sha256.Size]byte, plan Plan) [sha256.Size]byte {
	hash := sha256.New()
	_, _ = hash.Write(payload[:])
	_, _ = fmt.Fprintf(hash, "\x00%s", plan.Version)
	for _, step := range plan.Steps {
		_, _ = fmt.Fprintf(hash, "\x00%s:%t", step.Name, step.RetrySafe)
	}
	var result [sha256.Size]byte
	copy(result[:], hash.Sum(nil))
	return result
}
