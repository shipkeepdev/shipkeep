package actions

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

const (
	execContainer = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	execSessionID = "019d0000-0000-7000-8000-000000000001"
)

type output struct {
	stream int
	data   string
}

// fakeAttached is a started exec: its output comes from out, its stdin goes to stdin.
type fakeAttached struct {
	out         chan output
	mu          sync.Mutex
	stdin       strings.Builder
	stdinClosed bool
	closed      chan struct{}
	once        sync.Once
}

func newAttached() *fakeAttached {
	return &fakeAttached{out: make(chan output, 16), closed: make(chan struct{})}
}

func (f *fakeAttached) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stdin.Write(p)
}

func (f *fakeAttached) CloseStdin() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stdinClosed = true
	return nil
}

func (f *fakeAttached) Next(int) (int, []byte, error) {
	select {
	case o, ok := <-f.out:
		if !ok {
			return 0, nil, io.EOF
		}
		return o.stream, []byte(o.data), nil
	case <-f.closed:
		return 0, nil, errors.New("use of closed connection")
	}
}

func (f *fakeAttached) Close() error {
	f.once.Do(func() { close(f.closed) })
	return nil
}

type fakeExecEngine struct {
	labels   map[string]string
	attached *fakeAttached
	state    docker.ExecState
	mu       sync.Mutex
	created  []docker.ExecConfig
	resized  [][2]uint32
	startErr error
}

func (f *fakeExecEngine) Container(_ context.Context, ref string) (docker.Container, error) {
	if ref != execContainer && ref != "sk-app-1" {
		return docker.Container{}, docker.ErrNotFound
	}
	var container docker.Container
	container.ID = execContainer
	container.Config.Labels = f.labels
	return container, nil
}

func (f *fakeExecEngine) CreateExec(_ context.Context, _ string, config docker.ExecConfig) (docker.ExecInstance, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, config)
	return docker.ExecInstance{ID: strings.Repeat("e", 64), TTY: config.TTY}, nil
}

func (f *fakeExecEngine) StartExec(context.Context, docker.ExecInstance) (AttachedExec, error) {
	if f.startErr != nil {
		return nil, f.startErr
	}
	return f.attached, nil
}

func (f *fakeExecEngine) ResizeExec(_ context.Context, _ string, cols, rows uint32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resized = append(f.resized, [2]uint32{cols, rows})
	return nil
}

func (f *fakeExecEngine) InspectExec(context.Context, string) (docker.ExecState, error) {
	return f.state, nil
}

// fakeExecStream records what the agent sends and plays the control plane's frames.
type fakeExecStream struct {
	mu      sync.Mutex
	sent    []*agentv1.ExecStreamRequest
	in      chan *agentv1.ExecStreamResponse
	ctx     context.Context
	halfEnd bool
}

func (f *fakeExecStream) Send(frame *agentv1.ExecStreamRequest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.halfEnd {
		return errors.New("send after CloseSend")
	}
	f.sent = append(f.sent, frame)
	return nil
}

func (f *fakeExecStream) Recv() (*agentv1.ExecStreamResponse, error) {
	select {
	case frame, ok := <-f.in:
		if !ok {
			return nil, io.EOF
		}
		return frame, nil
	case <-f.ctx.Done():
		return nil, f.ctx.Err()
	}
}

func (f *fakeExecStream) CloseSend() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.halfEnd = true
	return nil
}

func (f *fakeExecStream) frames() []*agentv1.ExecStreamRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*agentv1.ExecStreamRequest(nil), f.sent...)
}

type fakeExecStreams struct {
	stream *fakeExecStream
	err    error
}

func (f *fakeExecStreams) OpenExec(ctx context.Context) (ExecStream, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.stream.ctx = ctx
	return f.stream, nil
}

func execFixture() (*fakeExecEngine, *fakeExecStreams) {
	engine := &fakeExecEngine{labels: map[string]string{docker.ManagedLabel: "true"}, attached: newAttached()}
	return engine, &fakeExecStreams{stream: &fakeExecStream{in: make(chan *agentv1.ExecStreamResponse, 16)}}
}

func validExec() *agentv1.ExecSession {
	return &agentv1.ExecSession{ContainerId: execContainer, Argv: []string{"sh"}, Tty: true, SessionId: execSessionID, TimeLimit: durationpb.New(time.Minute)}
}

func TestExecSessionRefusesMaliciousInput(t *testing.T) {
	engine, streams := execFixture()
	settings := &execSettings{engine: engine, streams: streams}
	for name, change := range map[string]func(*agentv1.ExecSession){
		"path traversal":        func(a *agentv1.ExecSession) { a.ContainerId = "../../etc" },
		"injection in the name": func(a *agentv1.ExecSession) { a.ContainerId = "sk-app;rm -rf /" },
		"uppercase id":          func(a *agentv1.ExecSession) { a.ContainerId = strings.ToUpper(execContainer) },
		"oversized name":        func(a *agentv1.ExecSession) { a.ContainerId = "sk-" + strings.Repeat("a", 61) },
		"no session id":         func(a *agentv1.ExecSession) { a.SessionId = "" },
		"session id not a uuid": func(a *agentv1.ExecSession) { a.SessionId = "../../exec" },
		"no argv":               func(a *agentv1.ExecSession) { a.Argv = nil },
		"empty argument":        func(a *agentv1.ExecSession) { a.Argv = []string{"ls", ""} },
		"NUL in an argument":    func(a *agentv1.ExecSession) { a.Argv = []string{"cat", "/etc/passwd\x00x"} },
		"invalid UTF-8":         func(a *agentv1.ExecSession) { a.Argv = []string{"echo", "\xff\xfe"} },
		"too many arguments":    func(a *agentv1.ExecSession) { a.Argv = make([]string, maxExecArgs+1); fill(a.Argv) },
		"oversized argument":    func(a *agentv1.ExecSession) { a.Argv = []string{strings.Repeat("a", maxExecArg+1)} },
		"oversized argv": func(a *agentv1.ExecSession) {
			a.Argv = []string{strings.Repeat("a", maxExecArg), strings.Repeat("b", maxExecArg), strings.Repeat("c", maxExecArg), strings.Repeat("d", maxExecArg), "e"}
		},
		"user with a shell":     func(a *agentv1.ExecSession) { a.User = "$(id)" },
		"user with a space":     func(a *agentv1.ExecSession) { a.User = "root -u 0" },
		"oversized user":        func(a *agentv1.ExecSession) { a.User = strings.Repeat("u", 33) },
		"user with three parts": func(a *agentv1.ExecSession) { a.User = "a:b:c" },
		"no time limit":         func(a *agentv1.ExecSession) { a.TimeLimit = nil },
		"zero time limit":       func(a *agentv1.ExecSession) { a.TimeLimit = durationpb.New(0) },
		"negative time limit":   func(a *agentv1.ExecSession) { a.TimeLimit = durationpb.New(-time.Minute) },
		"time limit over 4 h":   func(a *agentv1.ExecSession) { a.TimeLimit = durationpb.New(maxExecTime + time.Second) },
		"invalid duration":      func(a *agentv1.ExecSession) { a.TimeLimit = &durationpb.Duration{Seconds: 1, Nanos: -1} },
	} {
		action := validExec()
		change(action)
		if _, err := execSession(settings, action); !errors.Is(err, errInput) {
			t.Errorf("%s: %v", name, err)
		}
	}
	for _, user := range []string{"", "root", "1000", "1000:1000", "www-data", "app.user:staff"} {
		action := validExec()
		action.User = user
		if _, err := execSession(settings, action); err != nil {
			t.Errorf("refused the user %q: %v", user, err)
		}
	}
	plan, err := execSession(settings, validExec())
	if err != nil || len(plan.Steps) != 1 || plan.Steps[0].RetrySafe {
		t.Fatalf("a session must be one step that never resumes: %+v %v", plan, err)
	}
	if len(engine.created) != 0 {
		t.Fatal("planning created an exec")
	}
}

func fill(argv []string) {
	for i := range argv {
		argv[i] = "x"
	}
}

func TestExecSessionCarriesOutputAndTheExitCode(t *testing.T) {
	engine, streams := execFixture()
	engine.state = docker.ExecState{ExitCode: 3}
	engine.attached.out <- output{docker.Stdout, "hello"}
	engine.attached.out <- output{docker.Stderr, "warn"}
	close(engine.attached.out)
	config := docker.ExecConfig{Argv: []string{"sh", "-c", "exit 3"}}
	outcome, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, config)
	if err != nil || outcome.ExitCode != 3 || outcome.ResourceID != execContainer {
		t.Fatalf("got %+v, %v", outcome, err)
	}
	frames := streams.stream.frames()
	if len(frames) != 4 || frames[0].GetOpen().GetSessionId() != execSessionID || string(frames[1].GetStdout()) != "hello" || string(frames[2].GetStderr()) != "warn" || frames[3].GetExit().GetExitCode() != 3 {
		t.Fatalf("frames: %v", frames)
	}
	if len(engine.created) != 1 || engine.created[0].Argv[2] != "exit 3" {
		t.Fatalf("created: %+v", engine.created)
	}
}

func TestExecSessionForwardsStdinResizeAndClose(t *testing.T) {
	engine, streams := execFixture()
	in := streams.stream.in
	in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Stdin{Stdin: []byte("ls\n")}}
	in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Resize{Resize: &agentv1.ExecResize{Cols: 120, Rows: 40}}}
	// Out of bounds: ignored.
	in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Resize{Resize: &agentv1.ExecResize{Cols: 0, Rows: 40}}}
	in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Resize{Resize: &agentv1.ExecResize{Cols: 100000, Rows: 40}}}
	in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Close{Close: &agentv1.ExecClose{}}}
	done := make(chan error, 1)
	go func() {
		_, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, docker.ExecConfig{Argv: []string{"sh"}, TTY: true})
		done <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		engine.attached.mu.Lock()
		stdinClosed, stdin := engine.attached.stdinClosed, engine.attached.stdin.String()
		engine.attached.mu.Unlock()
		if stdinClosed {
			if stdin != "ls\n" {
				t.Fatalf("stdin %q", stdin)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stdin was never closed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Closing stdin keeps the session: its output still arrives, then it ends.
	engine.attached.out <- output{docker.Stdout, "after"}
	close(engine.attached.out)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	engine.mu.Lock()
	defer engine.mu.Unlock()
	if len(engine.resized) != 1 || engine.resized[0] != [2]uint32{120, 40} {
		t.Fatalf("resized: %v", engine.resized)
	}
	frames := streams.stream.frames()
	if string(frames[1].GetStdout()) != "after" || frames[len(frames)-1].GetExit() == nil {
		t.Fatalf("frames: %v", frames)
	}
}

func TestExecSessionEndsWhenTheControlPlaneKillsIt(t *testing.T) {
	engine, streams := execFixture()
	engine.state = docker.ExecState{Running: true}
	streams.stream.in <- &agentv1.ExecStreamResponse{Frame: &agentv1.ExecStreamResponse_Close{Close: &agentv1.ExecClose{Kill: true}}}
	outcome, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, docker.ExecConfig{Argv: []string{"sleep", "1000"}})
	if err != nil || outcome.ResourceID != execContainer {
		t.Fatalf("got %+v, %v", outcome, err)
	}
	frames := streams.stream.frames()
	if frames[len(frames)-1].GetError().GetMessage() != execClosed {
		t.Fatalf("frames: %v", frames)
	}
}

func TestExecSessionEndsWithItsStream(t *testing.T) {
	engine, streams := execFixture()
	close(streams.stream.in)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, docker.ExecConfig{Argv: []string{"sh"}})
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the session outlived its stream")
	}
}

func TestExecSessionStopsAtItsTimeLimit(t *testing.T) {
	engine, streams := execFixture()
	start := time.Now()
	outcome, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, 50*time.Millisecond, docker.ExecConfig{Argv: []string{"sh"}})
	if err != nil || time.Since(start) > 5*time.Second {
		t.Fatalf("got %+v, %v after %v", outcome, err, time.Since(start))
	}
	frames := streams.stream.frames()
	if frames[len(frames)-1].GetError().GetMessage() != execTimeLimit {
		t.Fatalf("frames: %v", frames)
	}
	select {
	case <-engine.attached.closed:
	default:
		t.Fatal("the connection to the command stayed open")
	}
}

func TestExecSessionSplitsLargeOutput(t *testing.T) {
	engine, streams := execFixture()
	engine.attached.out <- output{docker.Stdout, strings.Repeat("x", 3*execChunk+1)}
	close(engine.attached.out)
	if _, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, docker.ExecConfig{Argv: []string{"cat"}}); err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, frame := range streams.stream.frames() {
		if data := frame.GetStdout(); data != nil {
			if len(data) > execChunk {
				t.Fatalf("a frame of %d bytes", len(data))
			}
			total += len(data)
		}
	}
	if total != 3*execChunk+1 {
		t.Fatalf("got %d bytes", total)
	}
}

func TestExecSessionRefusesAForeignContainer(t *testing.T) {
	engine, streams := execFixture()
	engine.labels = map[string]string{}
	if _, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, docker.ExecConfig{Argv: []string{"sh"}}); !errors.Is(err, errForeign) {
		t.Fatalf("got %v", err)
	}
	if len(engine.created) != 0 || streams.stream.ctx != nil {
		t.Fatal("an exec or a stream was opened for a foreign container")
	}
}

func TestExecSessionWithoutAStreamStartsNothing(t *testing.T) {
	engine, streams := execFixture()
	streams.err = errors.New("no gateway session")
	engine.startErr = errors.New("must not start")
	if _, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, docker.ExecConfig{Argv: []string{"sh"}}); err == nil {
		t.Fatal("a session without a stream succeeded")
	}
}

func TestAFailedStartSaysSoWithAFixedText(t *testing.T) {
	engine, streams := execFixture()
	engine.startErr = errors.New("docker exec start: status 409 /var/lib/secret")
	if _, err := runExec(context.Background(), &execSettings{engine, streams}, execContainer, execSessionID, time.Minute, docker.ExecConfig{Argv: []string{"sh"}}); err == nil {
		t.Fatal("a failed start succeeded")
	}
	frames := streams.stream.frames()
	if frames[len(frames)-1].GetError().GetMessage() != execFailed {
		t.Fatalf("frames: %v", frames)
	}
}

func TestExecIsRegisteredOnlyWhenConfigured(t *testing.T) {
	if _, ok := DockerHandlers(newFakeEngine(), nil, nil)["exec_session"]; ok {
		t.Fatal("exec without its streams")
	}
	engine, streams := execFixture()
	if _, ok := DockerHandlers(newFakeEngine(), nil, nil, WithExec(engine, streams))["exec_session"]; !ok {
		t.Fatal("exec not registered")
	}
}
