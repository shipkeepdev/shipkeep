package actions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Bounds of an ExecSession (SPEC 3.3). A session runs a command inside a managed container, never
// on the host (CLAUDE.md rule 3), for at most maxExecTime.
const (
	maxExecArgs     = 64
	maxExecArg      = 4096
	maxExecArgv     = 16384
	maxExecTime     = 4 * time.Hour
	maxTerminalSide = 1000
	execChunk       = 32 << 10
)

// execFinalTimeout bounds the end of a session: the wait for its output, then for Docker's exit code.
var execFinalTimeout = 5 * time.Second

// execUser is a user, a uid, or either with a group, as Docker accepts them for an exec.
var execUser = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$`)

// ExecEngine is the part of the Docker client an exec session uses.
type ExecEngine interface {
	Container(ctx context.Context, ref string) (docker.Container, error)
	CreateExec(ctx context.Context, ref string, config docker.ExecConfig) (docker.ExecInstance, error)
	// StartExec starts the exec; ctx bounds the whole session.
	StartExec(ctx context.Context, instance docker.ExecInstance) (AttachedExec, error)
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
func (d dockerExec) StartExec(ctx context.Context, instance docker.ExecInstance) (AttachedExec, error) {
	attached, err := d.Client.StartExec(ctx, instance)
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

// WithExec runs ExecSession actions in managed containers, with frames over streams. The action
// starts a session and ends; sessions then run under their owner, which ends them all on Close.
func WithExec(engine ExecEngine, streams ExecStreams, sessions *ExecSessions) Option {
	return func(o *handlerOptions) {
		o.exec = &execSettings{engine: engine, streams: streams, sessions: sessions}
	}
}

type execSettings struct {
	engine   ExecEngine
	streams  ExecStreams
	sessions *ExecSessions
}

// ExecSessions owns the running exec sessions. They outlive the action that started them, whose
// journal step must end: the journal runs one step at a time, and a session lasts hours.
type ExecSessions struct {
	ctx     context.Context
	cancel  context.CancelFunc
	running sync.WaitGroup
	mu      sync.Mutex
	closed  bool
}

// NewExecSessions returns an owner with no session.
func NewExecSessions() *ExecSessions {
	ctx, cancel := context.WithCancel(context.Background())
	return &ExecSessions{ctx: ctx, cancel: cancel}
}

// Close ends every session, each saying so to the control plane, and waits for them.
func (s *ExecSessions) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.cancel()
	s.running.Wait()
}

// start runs session on its own goroutine, unless the owner is closed.
func (s *ExecSessions) start(session func()) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.running.Go(session)
	return true
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
	return journal.Plan{Version: "exec-session-v2", Steps: []journal.Step{{
		Name: "start",
		// A session cannot resume: its stream ends with the agent. A start the agent did not see
		// end is found uncertain after a restart, and compensated: it ends as failed.
		RetrySafe: false,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			return startSession(ctx, settings, ref, session, limit.AsDuration(), config)
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

// startSession starts a session: the command in the container, and the stream that carries its
// frames. The action ends there, and the session runs on under its owner for at most limit.
func startSession(ctx context.Context, settings *execSettings, ref, session string, limit time.Duration, config docker.ExecConfig) (journal.Outcome, error) {
	container, err := managedExecTarget(ctx, settings.engine, ref)
	if err != nil {
		return journal.Outcome{}, err
	}
	instance, err := settings.engine.CreateExec(ctx, container.ID, config)
	if err != nil {
		return journal.Outcome{}, fmt.Errorf("create exec: %w", err)
	}
	// The stream and the connection to the command outlive the action. The session ends them
	// itself, once it said why to the control plane, even when its owner closes.
	streamCtx, end := context.WithCancel(context.WithoutCancel(ctx))
	stream, err := settings.streams.OpenExec(streamCtx)
	if err != nil {
		end()
		return journal.Outcome{}, fmt.Errorf("open exec stream: %w", err)
	}
	if err := stream.Send(&agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Open{Open: &agentv1.ExecOpen{SessionId: session}}}); err != nil {
		end()
		return journal.Outcome{}, fmt.Errorf("open exec stream: %w", err)
	}
	attached, err := settings.engine.StartExec(streamCtx, instance)
	if err != nil {
		_ = stream.Send(execError(execFailed))
		_ = stream.CloseSend()
		end()
		return journal.Outcome{}, fmt.Errorf("start exec: %w", err)
	}
	if !settings.sessions.start(func() {
		defer end()
		relayExec(settings.sessions.ctx, end, settings.engine, instance, attached, stream, limit)
	}) {
		_ = attached.Close()
		end()
		return journal.Outcome{}, errors.New("the agent is stopping")
	}
	return journal.Outcome{ResourceID: container.ID}, nil
}

// relayExec carries one session's frames until the command's output ends, the control plane
// kills it or ends its stream, the time limit passes, or the owner closes (owner ends). end ends
// the stream and the connection to the command.
func relayExec(owner context.Context, end context.CancelFunc, engine ExecEngine, instance docker.ExecInstance, attached AttachedExec, stream ExecStream, limit time.Duration) {
	defer attached.Close() //nolint:errcheck // the session's end closes it
	// The control plane's frames to the command, until it kills the session or the stream ends.
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		forwardInput(context.WithoutCancel(owner), engine, instance.ID, attached, stream)
	}()
	// The command's output to the stream, on one goroutine alone: a stream's sends are not safe
	// from two goroutines at once, and the last frame waits for it.
	outputDone := make(chan error, 1)
	go func() { outputDone <- forwardOutput(attached, stream, instance.TTY) }()
	timer := time.NewTimer(limit)
	defer timer.Stop()
	reason, finished := "", false
	select {
	case err := <-outputDone:
		finished = true
		if err != nil {
			reason = execFailed
		}
	case <-inputDone:
		reason = execClosed
	case <-timer.C:
		reason = execTimeLimit
	case <-owner.Done():
		reason = execClosed
	}
	if !finished {
		// The output stops once its connection closes, unless the stream holds a send: past a
		// moment, the stream ends too, and the last frame is not sent.
		_ = attached.Close()
		select {
		case <-outputDone: //nolint:errcheck // its error is the close above
		case <-time.After(execFinalTimeout):
			end()
			<-outputDone //nolint:errcheck // its error is the end of the stream
		}
	}
	final := execError(reason)
	if reason == "" {
		finalCtx, cancel := context.WithTimeout(context.WithoutCancel(owner), execFinalTimeout)
		state, err := engine.InspectExec(finalCtx, instance.ID)
		cancel()
		if err == nil && !state.Running {
			final = &agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Exit{Exit: &agentv1.ExecExit{ExitCode: int32(state.ExitCode)}}} //nolint:gosec // Docker exit codes are small
		} else {
			// Its output ended and the command still runs, or Docker did not say.
			final = execError(execClosed)
		}
	}
	// A stalled stream cannot hold the session: past a moment it ends without its last frame.
	stop := time.AfterFunc(execFinalTimeout, end)
	_ = stream.Send(final)
	_ = stream.CloseSend()
	stop.Stop()
	end()
	<-inputDone
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
	stdinClosed := false
	for {
		message, err := stream.Recv()
		if err != nil {
			return
		}
		switch frame := message.GetFrame().(type) {
		case *agentv1.ExecStreamResponse_Stdin:
			// Input that was in flight when stdin closed has nowhere to go: it is dropped.
			if stdinClosed {
				continue
			}
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
			stdinClosed = true
			_ = attached.CloseStdin()
		}
	}
}

func execError(message string) *agentv1.ExecStreamRequest {
	return &agentv1.ExecStreamRequest{Frame: &agentv1.ExecStreamRequest_Error{Error: &agentv1.ExecError{Message: message}}}
}
