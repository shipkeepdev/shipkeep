package agent

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/sdnotify"
	"github.com/shipkeepdev/shipkeep/agent/internal/upgrade"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Timings of an upgrade (ADR 0028).
const (
	// confirmWithin is how long a new binary has to complete its first Hello. The unit's
	// TimeoutStartSec, 360 s, ends a binary that hangs before.
	confirmWithin = 5 * time.Minute
	// restartWithin bounds the wait for the upgrade's result to reach the control plane: without a
	// connection, the new binary answers its redelivery from the journal.
	restartWithin = 2 * time.Minute
)

// ErrUpgradeUnconfirmed ends a new binary that did not complete a Hello in time: systemd starts it
// again, and the upgrade guard counts the attempt.
var ErrUpgradeUnconfirmed = errors.New("the upgraded agent did not reach the control plane in time")

// errRestart ends the agent after a successful UpgradeAgent, so that systemd starts the new binary.
var errRestart = errors.New("restart into the upgraded binary")

// startup is how this start relates to an upgrade, read from the upgrade record.
type startup struct {
	stateDir string
	version  string
	logger   *slog.Logger
	notify   func(string) error

	// pending is set when this binary is the new one of an upgrade not yet confirmed.
	pending bool
	once    sync.Once
	// confirmed is closed once the first Hello is welcomed, or at once without a pending upgrade.
	confirmed chan struct{}
}

func newStartup(stateDir, version string, logger *slog.Logger, notify func(string) error) *startup {
	if notify == nil {
		notify = sdnotify.Notify
	}
	s := &startup{stateDir: stateDir, version: version, logger: logger, notify: notify, confirmed: make(chan struct{})}
	record, found, err := upgrade.ReadPending(stateDir)
	switch {
	case err != nil:
		logger.Error("upgrade record unreadable; it is ignored", "error", err)
	case !found:
	case record.To == version && record.State == upgrade.StatePending:
		s.pending = true
		logger.Info("upgraded agent starting; it confirms the upgrade once the control plane welcomes it", "from", record.From, "attempt", record.Attempts)
	case record.From == version && record.State == upgrade.StateRolledBack:
		logger.Error("the upgrade did not start and was rolled back", "to", record.To, "attempts", record.Attempts)
		s.clear()
	default:
		// An upgrade of another version, or one whose swap never happened: nothing to confirm.
		logger.Warn("stale upgrade record cleared", "from", record.From, "to", record.To, "state", record.State)
		s.clear()
	}
	return s
}

// started tells systemd the agent runs, unless a new binary must first reach the control plane:
// an agent keeps its workloads during an outage (CLAUDE.md rule 10), so a normal start never
// waits for the control plane.
func (s *startup) started() {
	if !s.pending {
		s.ready()
	}
}

// connected confirms a pending upgrade the first time the control plane welcomes the agent.
func (s *startup) connected() {
	if !s.pending {
		return
	}
	s.once.Do(func() {
		s.clear()
		s.logger.Info("upgrade confirmed", "version", s.version)
		s.ready()
	})
}

// deadline ends with ErrUpgradeUnconfirmed when a pending upgrade is not confirmed in time.
func (s *startup) deadline(ctx context.Context, within time.Duration) error {
	if !s.pending {
		return nil
	}
	timer := time.NewTimer(within)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil
	case <-s.confirmed:
		return nil
	case <-timer.C:
		return ErrUpgradeUnconfirmed
	}
}

func (s *startup) ready() {
	select {
	case <-s.confirmed:
	default:
		close(s.confirmed)
	}
	if err := s.notify(sdnotify.Ready); err != nil {
		s.logger.Warn("systemd not notified", "error", err)
	}
}

func (s *startup) clear() {
	if err := upgrade.ClearPending(s.stateDir); err != nil {
		s.logger.Error("upgrade record not cleared", "error", err)
	}
}

// restarter ends the agent once an UpgradeAgent's final update is sent, or after restartWithin.
type restarter struct {
	mu     sync.Mutex
	action string
	asked  chan struct{}
	sent   chan struct{}
}

func newRestarter() *restarter {
	return &restarter{asked: make(chan struct{}), sent: make(chan struct{})}
}

// request is called by the upgrade handler once the new binary is in place.
func (r *restarter) request(actionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.action != "" {
		return
	}
	r.action = actionID
	close(r.asked)
}

// delivered is called for each update written to the stream.
func (r *restarter) delivered(update *agentv1.ActionUpdate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.action == "" || update.GetActionId() != r.action || update.GetState() != agentv1.OperationState_OPERATION_STATE_SUCCEEDED {
		return
	}
	select {
	case <-r.sent:
	default:
		close(r.sent)
	}
}

// wait returns errRestart once a restart was asked and its result sent, or restartWithin after
// the request; nil when ctx ends first.
func (r *restarter) wait(ctx context.Context, within time.Duration) error {
	select {
	case <-ctx.Done():
		return nil
	case <-r.asked:
	}
	timer := time.NewTimer(within)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil
	case <-r.sent:
	case <-timer.C:
	}
	return errRestart
}
