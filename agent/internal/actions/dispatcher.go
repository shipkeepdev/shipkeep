// Package actions turns ActionRequests from the control plane into journaled operations.
//
// The action list is closed (CLAUDE.md rule 2): only kinds with a registered Handler run, every
// handler validates its input before any side effect, and the journal records intent first.
package actions

import (
	"context"
	"crypto/sha256"
	"errors"
	"regexp"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	"github.com/shipkeepdev/shipkeep/lib/agentproto"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Fixed, redacted error texts: an update never echoes request content.
const (
	errMalformed   = "malformed action request"
	errUnsupported = "action not supported by this agent"
	errInvalid     = "invalid action input"
	errStaleEpoch  = "stale lease epoch"
	errDeadline    = "action deadline exceeded"
	errFailed      = "action failed"
	errConflict    = "idempotency key reused for a different action"
)

var (
	actionID       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	idempotencyKey = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
)

// Handler validates one action kind and builds its versioned plan. Plan must reject malicious or
// out-of-range input with an error and must not touch the host; side effects belong in the steps.
type Handler struct {
	Plan   func(*agentv1.ActionRequest) (journal.Plan, error)
	Result func(journal.Outcome) *agentv1.ActionResult
}

// Executor is the journal: it records intent before running a plan and replays stored results.
type Executor interface {
	Execute(context.Context, journal.Request, journal.Plan, journal.Notify) (journal.Operation, error)
}

// Dispatcher runs actions with their own contexts, independent of any one stream connection, so
// an interrupted connection never interrupts an action. Updates are best effort: the control plane
// redelivers the request with the same idempotency key and receives the journaled outcome.
type Dispatcher struct {
	Journal  Executor
	Handlers map[string]Handler
	// Epoch returns the lease epoch this node holds; requests for another epoch are fenced.
	Epoch func() uint64
	Now   func() time.Time

	mu      sync.Mutex
	running map[string]context.CancelFunc
}

// Handle executes req and reports every transition through send. It returns when the action has
// a final state. send must not block indefinitely.
func (d *Dispatcher) Handle(ctx context.Context, req *agentv1.ActionRequest, send func(*agentv1.ActionUpdate)) {
	now := d.now()
	id := req.GetActionId()
	if !actionID.MatchString(id) || !idempotencyKey.MatchString(req.GetIdempotencyKey()) {
		send(failure(id, errMalformed, now))
		return
	}
	kind := agentproto.ActionKind(req)
	handler, ok := d.Handlers[kind]
	if kind == "" || !ok {
		send(failure(id, errUnsupported, now))
		return
	}
	if d.Epoch == nil || req.GetLeaseEpoch() != d.Epoch() {
		send(failure(id, errStaleEpoch, now))
		return
	}
	deadline := time.UnixMilli(req.GetDeadlineUnixMs())
	if req.GetDeadlineUnixMs() <= 0 || !deadline.After(now) {
		send(failure(id, errDeadline, now))
		return
	}
	plan, err := handler.Plan(req)
	if err != nil {
		send(failure(id, errInvalid, now))
		return
	}
	hash, err := payloadHash(req)
	if err != nil {
		send(failure(id, errMalformed, now))
		return
	}
	actionCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	if !d.track(id, cancel) {
		// The same action is already executing; its own updates will report the outcome.
		return
	}
	defer d.untrack(id)
	notify := func(_ context.Context, op journal.Operation) error {
		send(update(op, nil, d.now()))
		return nil
	}
	op, err := d.Journal.Execute(actionCtx, journal.Request{ID: id, Key: req.GetIdempotencyKey(), Kind: kind, PayloadHash: hash}, plan, notify)
	switch {
	case errors.Is(err, journal.ErrConflict):
		send(failure(id, errConflict, d.now()))
	case op.ID == "":
		message := errFailed
		if errors.Is(actionCtx.Err(), context.DeadlineExceeded) {
			message = errDeadline
		}
		send(failure(id, message, d.now()))
	default:
		var result *agentv1.ActionResult
		if op.State == journal.Succeeded && handler.Result != nil {
			result = handler.Result(op.Result)
		}
		send(update(op, result, d.now()))
	}
}

// Cancel requests cancellation of a running action; the journal compensates per its plan.
func (d *Dispatcher) Cancel(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	cancel, ok := d.running[id]
	if ok {
		cancel()
	}
	return ok
}

func (d *Dispatcher) track(id string, cancel context.CancelFunc) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.running == nil {
		d.running = map[string]context.CancelFunc{}
	}
	if _, busy := d.running[id]; busy {
		return false
	}
	d.running[id] = cancel
	return true
}

func (d *Dispatcher) untrack(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.running, id)
}

func (d *Dispatcher) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// payloadHash covers only the action message: ids, deadline and epoch may change on redelivery.
func payloadHash(req *agentv1.ActionRequest) ([sha256.Size]byte, error) {
	field := req.ProtoReflect().WhichOneof(req.ProtoReflect().Descriptor().Oneofs().ByName("action"))
	if field == nil {
		return [sha256.Size]byte{}, errors.New("missing action")
	}
	message := req.ProtoReflect().Get(field).Message().Interface()
	data, err := proto.MarshalOptions{Deterministic: true}.Marshal(message)
	if err != nil {
		return [sha256.Size]byte{}, err //nolint:wrapcheck // caller maps every error to a fixed message
	}
	return sha256.Sum256(append([]byte(string(field.Name())+"\x00"), data...)), nil
}

func update(op journal.Operation, result *agentv1.ActionResult, at time.Time) *agentv1.ActionUpdate {
	return &agentv1.ActionUpdate{
		ActionId:  op.ID,
		State:     state(op.State),
		Step:      op.Step,
		Attempts:  uint32(max(op.Attempts, 0)), //nolint:gosec // bounded by the journal
		Result:    result,
		UpdatedAt: timestamppb.New(at),
	}
}

func failure(id, message string, at time.Time) *agentv1.ActionUpdate {
	return &agentv1.ActionUpdate{ActionId: id, State: agentv1.OperationState_OPERATION_STATE_FAILED, Error: message, UpdatedAt: timestamppb.New(at)}
}

func state(value journal.State) agentv1.OperationState {
	switch value {
	case journal.Pending:
		return agentv1.OperationState_OPERATION_STATE_PENDING
	case journal.Running:
		return agentv1.OperationState_OPERATION_STATE_RUNNING
	case journal.Succeeded:
		return agentv1.OperationState_OPERATION_STATE_SUCCEEDED
	case journal.Failed:
		return agentv1.OperationState_OPERATION_STATE_FAILED
	case journal.Cancelled:
		return agentv1.OperationState_OPERATION_STATE_CANCELLED
	case journal.Compensating:
		return agentv1.OperationState_OPERATION_STATE_COMPENSATING
	case journal.Compensated:
		return agentv1.OperationState_OPERATION_STATE_COMPENSATED
	default:
		return agentv1.OperationState_OPERATION_STATE_UNSPECIFIED
	}
}
