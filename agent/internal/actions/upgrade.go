package actions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	"github.com/shipkeepdev/shipkeep/agent/internal/upgrade"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Causes of a refused upgrade, each with a fixed text in failureTexts (SPEC 3.4).
const (
	causeUpgradeDevBuild    = "upgrade_dev_build"
	causeUpgradeNotNewer    = "upgrade_not_newer"
	causeUpgradeUnitOld     = "upgrade_unit_outdated"
	causeUpgradeUnverified  = "upgrade_unverified"
	causeUpgradeUnavailable = "upgrade_unavailable"
)

// UnitFile is the agent's systemd unit, which the installer writes.
const UnitFile = "/etc/systemd/system/shipkeep-agent.service"

// guardLine is what an installer that supports upgrades puts in the unit: the upgrade guard
// counts the new binary's starts and puts the previous one back (ADR 0028).
const guardLine = "ExecStartPre=/usr/local/libexec/shipkeep-egress upgrade-guard"

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Upgrader is what UpgradeAgent needs from the node (ADR 0028). Production wiring sets Verify to
// upgrade.Verify; tests replace the network and the signature check, nothing else.
type Upgrader struct {
	// Version is the running agent's version.
	Version string
	// Arch is the architecture releases are taken for, runtime.GOARCH.
	Arch string
	// Binary returns the running binary's path, symbolic links resolved.
	Binary func() (string, error)
	// StateDir holds the upgrade record.
	StateDir string
	// UnitFile is the agent's systemd unit; the upgrade needs the guard in it.
	UnitFile string
	Client   *http.Client
	Verify   func(bundle []byte, digest [32]byte, version upgrade.Version) error
	// Restart asks the agent to restart once this action's final update is sent: systemd then
	// starts the new binary.
	Restart func(actionID string)
	Now     func() time.Time
}

// UpgradeHandler replaces the agent's own binary with a verified release (ADR 0028).
func UpgradeHandler(u Upgrader) Handler {
	return Handler{Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
		return u.plan(req.GetActionId(), req.GetUpgradeAgent())
	}}
}

func (u Upgrader) plan(actionID string, action *agentv1.UpgradeAgent) (journal.Plan, error) {
	if action == nil {
		return journal.Plan{}, errInput
	}
	version, err := upgrade.ParseVersion(action.GetVersion())
	if err != nil {
		return journal.Plan{}, errInput
	}
	// The control plane names a version; the address is the one the agent builds from it.
	address, err := upgrade.ArchiveURL(version, u.Arch)
	if err != nil || action.GetUrl() != address {
		return journal.Plan{}, errInput
	}
	want := action.GetSha256()
	bundle := action.GetCosignBundle().GetBundleJson()
	if !sha256Hex.MatchString(want) || len(bundle) == 0 || len(bundle) > 64<<10 {
		return journal.Plan{}, errInput
	}
	return journal.Plan{Version: "upgrade-agent-v1", Steps: []journal.Step{
		{
			// Download, verify and unpack: nothing on the host changes but `.next`.
			Name:      "fetch",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				binary, err := u.ready(version)
				if err != nil {
					return journal.Outcome{}, err
				}
				archive, err := upgrade.Download(ctx, u.Client, address, upgrade.MaxArchiveBytes)
				if err != nil {
					return journal.Outcome{}, errors.Join(err, causeError{causeUpgradeUnavailable})
				}
				digest := sha256.Sum256(archive)
				if hex.EncodeToString(digest[:]) != want {
					return journal.Outcome{}, causeError{causeUpgradeUnverified}
				}
				if err := u.Verify(bundle, digest, version); err != nil {
					return journal.Outcome{}, errors.Join(err, causeError{causeUpgradeUnverified})
				}
				agent, err := upgrade.ExtractAgent(archive)
				if err != nil {
					return journal.Outcome{}, errors.Join(err, causeError{causeUpgradeUnverified})
				}
				return journal.Outcome{ResourceID: version.String()}, upgrade.WriteNext(binary, agent)
			},
			Compensate: func(context.Context) error { return u.removeNext() },
		},
		{
			// The running binary keeps a second name, to go back to.
			Name:      "keep",
			RetrySafe: true,
			Apply: func(context.Context) (journal.Outcome, error) {
				if u.Version == version.String() {
					return journal.Outcome{ResourceID: version.String()}, nil
				}
				binary, err := u.Binary()
				if err != nil {
					return journal.Outcome{}, fmt.Errorf("find the running binary: %w", err)
				}
				// Once the swap happened, the binary is the new one: it is not kept as the previous.
				next, nextErr := upgrade.FileSHA256(binary + ".next")
				current, currentErr := upgrade.FileSHA256(binary)
				if nextErr != nil || currentErr != nil || next == current {
					return journal.Outcome{}, errors.Join(errors.New("no new binary to keep the running one for"), nextErr, currentErr)
				}
				return journal.Outcome{ResourceID: version.String()}, upgrade.LinkPrevious(binary)
			},
			Compensate: func(context.Context) error { return nil },
		},
		{
			// The record first, so that the guard counts the new binary's starts, then the swap.
			Name:      "swap",
			RetrySafe: true,
			Apply: func(context.Context) (journal.Outcome, error) {
				// Resumed by the new binary itself: the swap happened.
				if u.Version == version.String() {
					return journal.Outcome{ResourceID: version.String()}, nil
				}
				binary, err := u.Binary()
				if err != nil {
					return journal.Outcome{}, fmt.Errorf("find the running binary: %w", err)
				}
				next, err := upgrade.FileSHA256(binary + ".next")
				if err != nil {
					return journal.Outcome{}, err
				}
				record := upgrade.Pending{From: u.Version, To: version.String(), Binary: binary, SHA256: next, At: u.now(), State: upgrade.StatePending}
				if err := upgrade.WritePending(u.StateDir, record); err != nil {
					return journal.Outcome{}, err
				}
				if err := upgrade.Swap(binary, next); err != nil {
					return journal.Outcome{}, err
				}
				if u.Restart != nil {
					u.Restart(actionID)
				}
				return journal.Outcome{ResourceID: version.String()}, nil
			},
			// The swap is one rename: when it failed, the running binary is still in place and the
			// record would only make the guard count starts for nothing.
			Compensate: func(context.Context) error {
				record, found, err := upgrade.ReadPending(u.StateDir)
				if err != nil || !found || record.To != version.String() || u.Version == version.String() {
					return err
				}
				return upgrade.ClearPending(u.StateDir)
			},
		},
	}}, nil
}

// ready checks that this agent may replace itself with version, and returns its binary's path.
func (u Upgrader) ready(version upgrade.Version) (string, error) {
	running, err := upgrade.ParseVersion(u.Version)
	if err != nil {
		return "", causeError{causeUpgradeDevBuild}
	}
	if version.Compare(running) <= 0 {
		return "", causeError{causeUpgradeNotNewer}
	}
	unit, err := os.ReadFile(u.UnitFile)
	if err != nil || !strings.Contains(string(unit), guardLine) {
		return "", causeError{causeUpgradeUnitOld}
	}
	binary, err := u.Binary()
	if err != nil {
		return "", fmt.Errorf("find the running binary: %w", err)
	}
	return binary, nil
}

func (u Upgrader) now() time.Time {
	if u.Now != nil {
		return u.Now()
	}
	return time.Now()
}

func (u Upgrader) removeNext() error {
	binary, err := u.Binary()
	if err != nil {
		return nil //nolint:nilerr // no binary path, so no `.next` was written next to it
	}
	if err := os.Remove(binary + ".next"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove the new binary: %w", err)
	}
	return nil
}
