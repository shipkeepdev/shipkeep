package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/actions"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/credentials"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/gateway"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
	"github.com/samuelmbabhazi/shipkeep/lib/buildinfo"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/samuelmbabhazi/shipkeep/lib/secret"
)

func (a *Agent) runGateway(ctx context.Context, store *journal.Store) error {
	if ctx.Err() != nil {
		return nil //nolint:nilerr // Parent cancellation is a clean shutdown.
	}
	name := a.cfg.Node.Name
	if name == "" {
		hostname, err := os.Hostname()
		if err != nil {
			return fmt.Errorf("read node hostname: %w", err)
		}
		name = hostname
	}
	facts := &agentv1.NodeFacts{Hostname: name, Os: runtime.GOOS, Architecture: runtime.GOARCH}
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
		bundle, err = gateway.Enroll(ctx, a.cfg.ControlPlane.Address, a.cfg.ControlPlane.CAFingerprint, a.cfg.Dev, token, facts, buildinfo.Version)
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
	dispatcher := &actions.Dispatcher{Journal: store, Handlers: actions.Registry(), Epoch: func() uint64 { return epoch }}
	runner := gateway.Runner{Address: a.cfg.ControlPlane.Address, StateDir: a.cfg.Paths.StateDir, Version: buildinfo.Version, Facts: facts, Logger: a.logger, Actions: dispatcher}
	return runner.Run(ctx, bundle)
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
