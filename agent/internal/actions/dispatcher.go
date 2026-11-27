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

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
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

// What a failed step tells the control plane about its cause. The journal keeps a cause code;
// only the codes listed here become a text, each text is fixed, and anything else is errFailed.
// The control plane knows the same texts (SPEC 3.4).
var failureTexts = map[string]string{
	docker.CauseRegistryDenied:      "registry refused the pull",
	docker.CauseImageNotFound:       "image not found in the registry",
	docker.CauseRegistryUnreachable: "registry unreachable from the server",
	docker.CauseRegistryUntrusted:   "registry certificate not trusted by the server",
	docker.CauseDiskFull:            "no space left on the server",
	causeImageVolume:                "the image declares a volume the configuration does not mount",
	causeContainerNameTaken:         "a container with this name already exists on the server",
	causeEgressUnguarded:            "the server's Docker does not go through its egress proxy",
	causeUpgradeDevBuild:            "a development build of the agent is not upgraded",
	causeUpgradeNotNewer:            "the agent already runs this version or a later one",
	causeUpgradeUnitOld:             "the agent's service predates upgrades: run the server installer with --migrate yes",
	causeUpgradeUnverified:          "the release archive did not verify",
	causeUpgradeUnavailable:         "the release archive could not be downloaded",
	causeUpgradeInProgress:          "another upgrade of the agent is not confirmed yet",
	causeBuildFailed:                "the build failed: its output says why",
	causeBuildTimeout:               "the build did not finish in time",
	causeBuilderUnavailable:         "the server's builder does not answer",
}

// failureText is the fixed text for a failed operation: its cause when the agent lists it.
func failureText(cause string) string {
	if text, listed := failureTexts[cause]; listed {
		return text
	}
	return errFailed
}

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
	// Recover ends an operation past its deadline with no forward effect (issue #484).
	Recover(context.Context, journal.Request, journal.Plan, journal.Notify) (journal.Operation, error)
}

// recoveryTimeout bounds the undoing of an operation whose deadline passed: its own context, since
// the action's deadline is gone.
const recoveryTimeout = 2 * time.Minute

// Dispatcher runs actions with their own contexts, independent of any one stream connection, so
// an interrupted connection never interrupts an action. Updates go to the latest delivery of the
// action: the control plane redelivers it on a new stream, and a delivery while it runs attaches
// to it (issue #483), one after it ended replays the journaled outcome.
type Dispatcher struct {
	Journal  Executor
	Handlers map[string]Handler
	// Epoch returns the lease epoch this node holds; requests for another epoch are fenced.
	Epoch func() uint64
	Now   func() time.Time
	// RecoveryTimeout bounds one recovery; zero means recoveryTimeout. Tests shorten it.
	RecoveryTimeout time.Duration

	mu      sync.Mutex
	running map[string]*inflight
}

// inflight is a running action: how to cancel it, where its updates go, and the last one sent.
type inflight struct {
	cancel context.CancelFunc

	mu   sync.Mutex
	send func(*agentv1.ActionUpdate)
	last *agentv1.ActionUpdate
}

// publish sends an update to the action's current delivery and keeps it for a later one.
func (a *inflight) publish(update *agentv1.ActionUpdate) {
	a.mu.Lock()
	a.last = update
	send := a.send
	a.mu.Unlock()
	send(update)
}

// attach makes send the action's delivery: an earlier one hears nothing more. The new one gets
// the last update at once, then every later one, the final state included.
func (a *inflight) attach(send func(*agentv1.ActionUpdate)) {
	a.mu.Lock()
	a.send = send
	last := a.last
	a.mu.Unlock()
	if last != nil {
		send(last)
	}
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
	if req.GetDeadlineUnixMs() <= 0 {
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
	if !deadline.After(now) {
		// Past its deadline, an action never starts, and one the journal holds unfinished is undone
		// (issue #484).
		d.recover(ctx, req, kind, hash, plan, handler, send)
		return
	}
	actionCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	action, fresh := d.track(id, cancel, send)
	if !fresh {
		// The same action is already executing, for an earlier delivery: its updates and its
		// outcome now go to this one.
		action.attach(send)
		return
	}
	defer d.untrack(id)
	send = action.publish
	// Every update of a final state carries its outcome. The control plane closes an action on the
	// first final update it receives, so a result sent only afterwards would be dropped.
	report := func(op journal.Operation) *agentv1.ActionUpdate {
		next := update(op, nil, d.now())
		switch op.State {
		case journal.Succeeded:
			if handler.Result != nil {
				next.Result = handler.Result(op.Result)
			}
		case journal.Failed, journal.Compensated:
			next.Error = failureText(op.Cause)
		case journal.Pending, journal.Running, journal.Compensating, journal.Cancelled:
		}
		return next
	}
	notify := func(_ context.Context, op journal.Operation) error {
		send(report(op))
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
		send(report(op))
	}
}

// recover ends an overdue action: attached to its execution when it still runs here, otherwise
// undone from the journal with a bounded context of its own, or refused when the journal never saw
// it. Its final update says the deadline passed, unless a failed step named a cause.
func (d *Dispatcher) recover(ctx context.Context, req *agentv1.ActionRequest, kind string, hash [sha256.Size]byte, plan journal.Plan, handler Handler, send func(*agentv1.ActionUpdate)) {
	id := req.GetActionId()
	bound := recoveryTimeout
	if d.RecoveryTimeout > 0 {
		bound = d.RecoveryTimeout
	}
	recoveryCtx, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	action, fresh := d.track(id, cancel, send)
	if !fresh {
		action.attach(send)
		return
	}
	defer d.untrack(id)
	send = action.publish
	final := func(op journal.Operation) *agentv1.ActionUpdate {
		next := update(op, nil, d.now())
		switch op.State {
		case journal.Succeeded:
			if handler.Result != nil {
				next.Result = handler.Result(op.Result)
			}
		case journal.Cancelled:
			// Nothing of it ever ran: the control plane keeps it expired.
			next.Error = errDeadline
		case journal.Compensated:
			next.Error = errDeadline
			if op.Cause != "" {
				next.Error = failureText(op.Cause)
			}
		case journal.Failed:
			// It ran and could not be undone: never reported as an action that never ran.
			next.Error = errFailed
			if op.Cause != "" {
				next.Error = failureText(op.Cause)
			}
		case journal.Pending, journal.Running, journal.Compensating:
		}
		return next
	}
	notify := func(_ context.Context, op journal.Operation) error {
		send(final(op))
		return nil
	}
	op, err := d.Journal.Recover(recoveryCtx, journal.Request{ID: id, Key: req.GetIdempotencyKey(), Kind: kind, PayloadHash: hash}, plan, notify)
	switch {
	case errors.Is(err, journal.ErrNotFound):
		send(failure(id, errDeadline, d.now()))
	case errors.Is(err, journal.ErrConflict):
		send(failure(id, errConflict, d.now()))
	case op.ID == "":
		// The journal could not be locked or read in time: nothing is reported, and the control
		// plane delivers the action again, while its recovery window lasts.
	default:
		send(final(op))
	}
}

// Cancel requests cancellation of a running action; the journal compensates per its plan.
func (d *Dispatcher) Cancel(id string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	action, ok := d.running[id]
	if ok {
		action.cancel()
	}
	return ok
}

// track registers a new running action, or returns the one already running under this id.
func (d *Dispatcher) track(id string, cancel context.CancelFunc, send func(*agentv1.ActionUpdate)) (*inflight, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.running == nil {
		d.running = map[string]*inflight{}
	}
	if action, busy := d.running[id]; busy {
		return action, false
	}
	action := &inflight{cancel: cancel, send: send}
	d.running[id] = action
	return action, true
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
