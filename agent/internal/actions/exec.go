package actions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Bounds of an ExecSession (SPEC 3.3). A session runs a command inside a managed container, never
// on the host (CLAUDE.md rule 3), for at most maxExecTime.
const (
	maxExecArgs      = 64
	maxExecArg       = 4096
	maxExecArgv      = 16384
	maxExecTime      = 4 * time.Hour
	maxTerminalSide  = 1000
	execChunk        = 32 << 10
	execFinalTimeout = 5 * time.Second
)

// execUser is a user, a uid, or either with a group, as Docker accepts them for an exec.
var execUser = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$`)

// ExecEngine is the part of the Docker client an exec session uses.
type ExecEngine interface {
	Container(ctx context.Context, ref string) (docker.Container, error)
	CreateExec(ctx context.Context, ref string, config docker.ExecConfig) (string, error)
	StartExec(ctx context.Context, id string, tty bool) (AttachedExec, error)
	ResizeExec(ctx context.Context, id string, cols, rows uint32) error
	InspectExec(ctx context.Context, id string) (docker.ExecState, error)
}

// AttachedExec is a started exec's connection (docker.Exec).
type AttachedExec interface {
	Write(p []byte) (int, error)
	CloseStdin() error
	Next(max int) (int, []byte, error)
	Close() error
}

// DockerExec is the Docker client as an ExecEngine.
func DockerExec(client *docker.Client) ExecEngine { return dockerExec{client} }

type dockerExec struct{ *docker.Client }

// StartExec starts the exec and returns its connection; a nil one never hides in the interface.
func (d dockerExec) StartExec(ctx context.Context, id string, tty bool) (AttachedExec, error) {
	attached, err := d.Client.StartExec(ctx, id, tty)
	if err != nil {
		return nil, err
	}
	return attached, nil
}

// ExecStream is the agent's side of one ExecStream RPC.
type ExecStream interface {
	Send(*agentv1.ExecStreamRequest) error
	Recv() (*agentv1.ExecStreamResponse, error)
	CloseSend() error
}

// ExecStreams opens an ExecStream on the current gateway session; ctx bounds it.
type ExecStreams interface {
	OpenExec(ctx context.Context) (ExecStream, error)
}

// WithExec runs ExecSession actions in managed containers, with frames over streams.
func WithExec(engine ExecEngine, streams ExecStreams) Option {
	return func(o *handlerOptions) { o.exec = &execSettings{engine: engine, streams: streams} }
}

type execSettings struct {
	engine  ExecEngine
	streams ExecStreams
}

// Fixed texts of an ExecError frame: never Docker's message, which can name paths.
const (
	execTimeLimit = "time limit reached"
	execClosed    = "session closed"
	execFailed    = "session failed"
)

func execSession(settings *execSettings, action *agentv1.ExecSession) (journal.Plan, error) {
	ref, argv, user, session := action.GetContainerId(), action.GetArgv(), action.GetUser(), action.GetSessionId()
	if !containerRef.MatchString(ref) || !actionID.MatchString(session) || !validArgv(argv) || (user != "" && !execUser.MatchString(user)) {
		return journal.Plan{}, errInput
	}
	limit := action.GetTimeLimit()
	if limit == nil || limit.CheckValid() != nil || limit.AsDuration() < time.Second || limit.AsDuration() > maxExecTime {
		return journal.Plan{}, errInput
	}
	config := docker.ExecConfig{Argv: append([]string(nil), argv...), TTY: action.GetTty(), User: user}
	return journal.Plan{Version: "exec-session-v1", Steps: []journal.Step{{
		Name: "session",
		// A session cannot resume: its stream ended with the agent. After a restart the journal
		// finds it uncertain and compensates, which ends it as failed.
		RetrySafe: false,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			return runExec(ctx, settings, ref, session, limit.AsDuration(), config)
		},
		// Docker has no call that stops an exec's process: one that outlives its session runs
		// until it exits or its container stops. Nothing else is left to undo.
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

func validArgv(argv []string) bool {
	if len(argv) == 0 || len(argv) > maxExecArgs {
		return false
	}
	total := 0
	for _, arg := range argv {
		total += len(arg)
		if arg == "" || len(arg) > maxExecArg || !utf8.ValidString(arg) || strings.ContainsRune(arg, 0) {
			return false
		}
	}
	return total <= maxExecArgv
}

// runExec runs one session: the command in the container, its output to the stream, the
// stream's stdin, resizes and close to the command. It ends when the command's output ends, the
// control plane closes the session or ends the stream, or the time limit passes. ctx is the
// action's: the stream outlives the time limit long enough to say so.
func runExec(ctx context.Context, settings *execSettings, ref, session string, limit time.Duration, config docker.ExecConfig) (journal.Outcome, error) {
	container, err := managedExecTarget(ctx, settings.engine, ref)
	if err != nil {
		return journal.Outcome{}, err
	}
	id, err := settings.engine.CreateExec(ctx, container.ID, config)
	if err != nil {
		return journal.Outcome{}, fmt.Errorf("create exec: %w", err)
	}
	streamCtx, stopStream := context.WithCancel(ctx)
	defer stopStream()
	stream, err := settings.streams.OpenExec(streamCtx)
	if err != nil {
		return journal.Outcome{}, fmt.Errorf("open exec stream: %w", err)
	}
	if err := stream.Send(&agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Open{Open: &agentv1.ExecOpen{SessionId: session}}}); err != nil {
		return journal.Outcome{}, fmt.Errorf("open exec stream: %w", err)
	}
	attached, err := settings.engine.StartExec(ctx, id, config.TTY)
	if err != nil {
		_ = stream.Send(execError(execFailed))
		_ = stream.CloseSend()
		return journal.Outcome{}, fmt.Errorf("start exec: %w", err)
	}
	defer attached.Close() //nolint:errcheck // the session's end closes it
	// The stream's frames to the command. Once the control plane kills the session or the stream
	// ends, the connection to the command closes, which ends its output below.
	var ended atomic.Bool
	var receiving sync.WaitGroup
	receiving.Go(func() {
		forwardInput(streamCtx, settings.engine, id, attached, stream)
		ended.Store(true)
		_ = attached.Close()
	})
	// The command's output to the stream, on one goroutine alone: a stream's sends are not safe
	// from two goroutines at once, and the last frame waits for it.
	outputDone := make(chan error, 1)
	go func() { outputDone <- forwardOutput(attached, stream, config.TTY) }()
	timer := time.NewTimer(limit)
	defer timer.Stop()
	reason := ""
	select {
	case err = <-outputDone:
		switch {
		case ended.Load():
			reason = execClosed
		case err != nil:
			reason = execFailed
		}
	case <-timer.C:
		reason = execTimeLimit
	case <-ctx.Done():
		reason = execTimeLimit
	}
	if reason == execTimeLimit {
		_ = attached.Close()
		<-outputDone //nolint:errcheck // the output stops on the close above, which is its error
	}
	outcome := journal.Outcome{ResourceID: container.ID}
	final := execError(reason)
	if reason == "" {
		finalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), execFinalTimeout)
		state, inspectErr := settings.engine.InspectExec(finalCtx, id)
		cancel()
		if inspectErr == nil && !state.Running {
			outcome.ExitCode = int32(state.ExitCode) //nolint:gosec // Docker exit codes are small
			final = &agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Exit{Exit: &agentv1.ExecExit{ExitCode: outcome.ExitCode}}}
		} else {
			// Its output ended and the command still runs, or Docker did not say.
			reason, final = execClosed, execError(execClosed)
		}
	}
	_ = stream.Send(final)
	_ = stream.CloseSend()
	stopStream()
	receiving.Wait()
	if reason == execFailed {
		return journal.Outcome{}, errors.New("exec session failed")
	}
	return outcome, nil
}

// managedExecTarget is the running managed container ref names.
func managedExecTarget(ctx context.Context, engine ExecEngine, ref string) (docker.Container, error) {
	container, err := engine.Container(ctx, ref)
	if err != nil {
		return docker.Container{}, fmt.Errorf("inspect container: %w", err)
	}
	if container.Config.Labels[docker.ManagedLabel] != "true" {
		return docker.Container{}, errForeign
	}
	return container, nil
}

// forwardOutput sends the command's output as stdout and stderr frames of at most execChunk
// bytes, until it ends (nil) or the stream breaks.
func forwardOutput(attached AttachedExec, stream ExecStream, tty bool) error {
	for {
		kind, data, err := attached.Next(execChunk)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		for len(data) > 0 {
			chunk := data[:min(len(data), execChunk)]
			data = data[len(chunk):]
			frame := &agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Stdout{Stdout: chunk}}
			if kind == docker.Stderr && !tty {
				frame = &agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Stderr{Stderr: chunk}}
			}
			if err := stream.Send(frame); err != nil {
				return fmt.Errorf("send exec output: %w", err)
			}
		}
	}
}

// forwardInput applies the control plane's frames until it kills the session or the stream ends.
// Closing stdin keeps the session: the command's output still reaches the stream.
func forwardInput(ctx context.Context, engine ExecEngine, id string, attached AttachedExec, stream ExecStream) {
	for {
		message, err := stream.Recv()
		if err != nil {
			return
		}
		switch frame := message.GetFrame().(type) {
		case *agentv1.ExecStreamResponse_Stdin:
			if _, err := attached.Write(frame.Stdin); err != nil {
				return
			}
		case *agentv1.ExecStreamResponse_Resize:
			cols, rows := frame.Resize.GetCols(), frame.Resize.GetRows()
			if cols >= 1 && rows >= 1 && cols <= maxTerminalSide && rows <= maxTerminalSide {
				_ = engine.ResizeExec(ctx, id, cols, rows)
			}
		case *agentv1.ExecStreamResponse_Close:
			if frame.Close.GetKill() {
				return
			}
			_ = attached.CloseStdin()
		}
	}
}

func execError(message string) *agentv1.ExecStreamRequest {
	return &agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Error{Error: &agentv1.ExecError{Message: message}}}
}
