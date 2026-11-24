package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"

	"github.com/shipkeepdev/shipkeep/agent/internal/actions"
	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/certwatch"
	"github.com/shipkeepdev/shipkeep/agent/internal/confirm"
	"github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/gateway"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	"github.com/shipkeepdev/shipkeep/agent/internal/metrics"
	"github.com/shipkeepdev/shipkeep/agent/internal/reporting"
	"github.com/shipkeepdev/shipkeep/agent/internal/upgrade"
	"github.com/shipkeepdev/shipkeep/lib/buildinfo"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/shipkeepdev/shipkeep/lib/secret"
)

func (a *Agent) runGateway(ctx context.Context, store *journal.Store, engine *docker.Client, router *caddy.Client, routes *actions.RouteBook, boot *startup, restart *restarter) error {
	if ctx.Err() != nil {
		return nil // Parent cancellation is a clean shutdown.
	}
	name := a.cfg.Node.Name
	if name == "" {
		hostname, err := os.Hostname()
		if err != nil {
			return fmt.Errorf("read node hostname: %w", err)
		}
		name = hostname
	}
	// Capacity facts (CPU, memory, disk) feed scheduling (SPEC 6); the configured name wins.
	reservation := actions.Reservation{CPUMillis: a.cfg.Node.Reservation.CPUMillis, MemoryBytes: a.cfg.Node.Reservation.MemoryBytes}
	facts := actions.Facts(ctx, a.cfg.Paths.StateDir, engine, reservation)
	facts.Hostname = name
	bundle, err := credentials.Load(a.cfg.Paths.StateDir, a.cfg.ControlPlane.CAFingerprint)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if errors.Is(err, os.ErrNotExist) {
		path := a.cfg.ControlPlane.JoinTokenFile
		if path == "" {
			if !a.cfg.Dev {
				return errors.New("enrollment requires control_plane.join_token_file")
			}
			a.logger.Warn("agent is not enrolled; configure a private join-token file")
			<-ctx.Done()
			return nil
		}
		token, err := readJoinToken(path)
		if err != nil {
			return err
		}
		bundle, err = gateway.Enroll(ctx, a.endpoint(), a.cfg.ControlPlane.CAFingerprint, a.cfg.Dev, token, facts, buildinfo.Version)
		if err != nil {
			return err
		}
		if err := bundle.Save(a.cfg.Paths.StateDir); err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove consumed join-token file: %w", err)
		}
		a.logger.Info("agent enrolled", "node_id", bundle.NodeID)
	}
	epoch := bundle.LeaseEpoch
	confirmations, err := confirm.NewVerifier(bundle.ConfirmationPublicKey, bundle.OrganizationID, store)
	if err != nil {
		return err
	}
	// The certificates Caddy serves, read on loopback and reported with the state (PLAN M3.6b2).
	certificates := &certwatch.Watcher{Hosts: router, Logger: a.logger, Address: "127.0.0.1:443", Interval: time.Minute, Refresh: 10 * time.Minute}
	watchCtx, stopWatching := context.WithCancel(ctx)
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		certificates.Run(watchCtx)
	}()
	defer func() {
		stopWatching()
		<-watched
	}()
	// Secures the routes an older agent wrote, without waiting for the next deployment. Caddy may
	// still be starting, so it is retried until it succeeds; it stops with this gateway run.
	secureCtx, stopSecuring := context.WithCancel(ctx)
	secured := make(chan struct{})
	go func() {
		defer close(secured)
		secureRoutesUntilDone(secureCtx, router, a.logger, time.Second, time.Minute)
	}()
	defer func() {
		stopSecuring()
		<-secured
	}()
	// Facts are read when the result is built, after the action's context ended.
	collectFacts := actions.FactsHandler(a.cfg.Paths.StateDir, engine, reservation) //nolint:contextcheck // see above
	options := []actions.Option{
		actions.WithWorkloads(actions.Workloads{Slice: a.cfg.Docker.WorkloadsSlice, OOMScoreAdj: a.cfg.Docker.WorkloadsOOMScoreAdj}),
		// The reconciler follows the containers of each route (ADR 0017).
		actions.WithRouteBook(routes),
		// The agent replaces its own binary with a verified release (ADR 0028).
		actions.WithUpgrader(actions.Upgrader{
			Version: buildinfo.Version, Arch: runtime.GOARCH, Binary: upgrade.BinaryPath,
			StateDir: a.cfg.Paths.StateDir, UnitFile: actions.UnitFile,
			Client: upgrade.Client(), Verify: upgrade.Verify, Restart: restart.request,
		}),
	}
	if host := a.cfg.ControlPlane.Route.Host; host != "" {
		// No application may take the control plane's name (ADR 0021).
		options = append(options, actions.WithReservedHosts(host))
	}
	if a.cfg.Dev {
		// A development machine has no egress proxy in front of its Docker daemon (ADR 0023).
		a.logger.Warn("development mode: image pulls do not require the egress proxy")
		options = append(options, actions.WithoutEgressCheck())
	}
	// Exec sessions in managed containers, with their frames on an ExecStream (SPEC 3.1).
	streams := &gateway.Streams{}
	sessions := actions.NewExecSessions()
	// Sessions end with this gateway run, each saying so, before the journal closes.
	defer sessions.Close()
	options = append(options, actions.WithExec(actions.DockerExec(engine), execStreams{streams}, sessions))
	dispatcher := &actions.Dispatcher{Journal: store, Handlers: actions.Registry(engine, confirmations, router, store, collectFacts, options...), Epoch: func() uint64 { return epoch }}
	// Node, container and route metrics, sent on the stream when the control plane accepts them.
	sampler := &metrics.Sampler{Containers: engine, Requests: router, Proc: "/proc", Sys: "/sys", Logger: a.logger}
	runner := gateway.Runner{
		Endpoint: a.endpoint(), StateDir: a.cfg.Paths.StateDir, Version: buildinfo.Version, Facts: facts, Logger: a.logger, Actions: dispatcher,
		Metrics:   sampler.Sample,
		Connected: boot.connected,
		Sent:      restart.delivered,
		Streams:   streams,
		Report: func(ctx context.Context) (*agentv1.StateReport, error) {
			reasons, err := store.StopReasons(ctx)
			if err != nil {
				return nil, err
			}
			report, err := reporting.SnapshotWithReasons(ctx, engine, reasons)
			if err != nil {
				return nil, err
			}
			// The containers first: the certificates take the room they leave in the report,
			// with a margin for the epoch and the time added when it is sent.
			report.Certificates = certwatch.Within(certificates.Snapshot(time.Now()), gateway.MaxReportBytes-64-proto.Size(report))
			return report, nil
		},
	}
	return runner.Run(ctx, bundle)
}

// execStreams opens exec sessions' streams on the gateway session's connection.
type execStreams struct{ streams *gateway.Streams }

// OpenExec opens an ExecStream, which ends with ctx or with the session's connection.
func (e execStreams) OpenExec(ctx context.Context) (actions.ExecStream, error) {
	return e.streams.OpenExec(ctx)
}

func readJoinToken(path string) (secret.String, error) {
	root, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return secret.String{}, fmt.Errorf("open join-token directory: %w", err)
	}
	defer root.Close() //nolint:errcheck // read-only directory
	name := filepath.Base(path)
	info, err := root.Lstat(name)
	if err != nil {
		return secret.String{}, fmt.Errorf("inspect join-token file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() > 44 {
		return secret.String{}, errors.New("join-token file must be a regular 0600 file of at most 44 bytes")
	}
	file, err := root.Open(name)
	if err != nil {
		return secret.String{}, fmt.Errorf("open join-token file: %w", err)
	}
	defer file.Close() //nolint:errcheck // read-only file
	data, err := io.ReadAll(io.LimitReader(file, 45))
	if err != nil {
		return secret.String{}, fmt.Errorf("read join-token file: %w", err)
	}
	if len(data) > 44 {
		return secret.String{}, errors.New("join-token file is too large")
	}
	return secret.NewString(strings.TrimSuffix(string(data), "\n")), nil
}

// secureRoutesUntilDone runs SecureRoutes until it succeeds or ctx ends, waiting first, then twice
// as long after each failure, up to most. Each failure is logged; Caddy's own error text is not in
// it (the client reports statuses only).
func secureRoutesUntilDone(ctx context.Context, router interface{ SecureRoutes(context.Context) error }, logger *slog.Logger, first, most time.Duration) {
	delay := first
	for {
		err := router.SecureRoutes(ctx)
		if err == nil || ctx.Err() != nil {
			return
		}
		logger.Warn("caddy routes not checked yet; retrying", "error", err, "retry_in", delay.String())
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		delay = min(delay*2, most)
	}
}

// endpoint is the gateway as the configuration names it: the verified address, and the loopback
// address to connect to on the machine that hosts the control plane (ADR 0021).
func (a *Agent) endpoint() gateway.Endpoint {
	return gateway.Endpoint{Address: a.cfg.ControlPlane.Address, Connect: a.cfg.ControlPlane.Connect}
}
