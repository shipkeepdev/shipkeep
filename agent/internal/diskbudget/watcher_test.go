package diskbudget

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/actions"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
)

type fakeEngine struct {
	containers []docker.ContainerSummary
	listErr    error
	stopErr    error
	stopped    map[string]int
}

func (f *fakeEngine) ManagedContainersWithSize(context.Context) ([]docker.ContainerSummary, error) {
	return f.containers, f.listErr
}

func (f *fakeEngine) StopContainer(_ context.Context, id string, timeout int) error {
	if f.stopErr != nil {
		return f.stopErr
	}
	f.stopped[id] = timeout
	return nil
}

type fakeState struct {
	order   []string
	intents map[string]bool
	reasons map[string]string
	fail    bool
}

func (f *fakeState) SetIntent(_ context.Context, name string, running bool, _ time.Time) error {
	if f.fail {
		return errors.New("disk full")
	}
	f.order = append(f.order, "intent")
	f.intents[name] = running
	return nil
}

func (f *fakeState) RecordStopReason(_ context.Context, name, reason string, _ time.Time) error {
	f.order = append(f.order, "reason")
	f.reasons[name] = reason
	return nil
}

func container(name, state string, size int64, budget string) docker.ContainerSummary {
	labels := map[string]string{docker.ManagedLabel: "true"}
	if budget != "" {
		labels[actions.DiskBudgetLabel] = budget
	}
	return docker.ContainerSummary{ID: strings.Repeat(name[len(name)-1:], 64), Names: []string{"/" + name}, State: state, Labels: labels, SizeRw: size}
}

func watcher(engine *fakeEngine, state *fakeState) (Watcher, *bytes.Buffer) {
	var logs bytes.Buffer
	return Watcher{Engine: engine, State: state, Logger: slog.New(slog.NewJSONHandler(&logs, nil))}, &logs
}

func TestStopsOnlyContainersOverTheirBudget(t *testing.T) {
	engine := &fakeEngine{stopped: map[string]int{}, containers: []docker.ContainerSummary{
		container("sk-over-1", "running", 100<<20, "67108864"),
		container("sk-under-2", "running", 10<<20, "67108864"),
		container("sk-equal-3", "running", 64<<20, "67108864"),
		// From an older control plane, or a container the watcher must not judge.
		container("sk-unbudgeted-4", "running", 50<<30, ""),
		container("sk-exited-5", "exited", 100<<20, "67108864"),
	}}
	state := &fakeState{intents: map[string]bool{}, reasons: map[string]string{}}
	w, logs := watcher(engine, state)
	if err := w.Pass(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(engine.stopped) != 1 || engine.stopped[strings.Repeat("1", 64)] != StopSeconds {
		t.Fatalf("stopped %v, want only sk-over-1 with a %d-second grace", engine.stopped, StopSeconds)
	}
	// The intent first, so that the reconciler never starts it again, then the reason.
	if strings.Join(state.order, ",") != "intent,reason" || state.intents["sk-over-1"] || state.reasons["sk-over-1"] != Reason {
		t.Fatalf("recorded %v %v %v", state.order, state.intents, state.reasons)
	}
	if !strings.Contains(logs.String(), `"container":"sk-over-1"`) || !strings.Contains(logs.String(), `"budget_bytes":67108864`) {
		t.Fatalf("stop not logged: %s", logs.String())
	}
}

func TestIgnoresBudgetLabelsTheAgentWouldNotWrite(t *testing.T) {
	for _, label := range []string{
		"abc", "-1", "0", "67108863", "1099511627777", "18446744073709551616", "067108864",
		"67108864 ", "+67108864", "6.7e7", strings.Repeat("9", 30), "0x4000000",
	} {
		engine := &fakeEngine{stopped: map[string]int{}, containers: []docker.ContainerSummary{container("sk-forged-1", "running", 1<<40, label)}}
		state := &fakeState{intents: map[string]bool{}, reasons: map[string]string{}}
		w, _ := watcher(engine, state)
		if err := w.Pass(t.Context()); err != nil {
			t.Fatal(err)
		}
		if len(engine.stopped) != 0 || len(state.order) != 0 {
			t.Fatalf("label %q was read as a budget", label)
		}
	}
	for label, want := range map[string]uint64{"67108864": 64 << 20, "1073741824": 1 << 30, "1099511627776": 1 << 40} {
		if got, ok := Budget(label); !ok || got != want {
			t.Fatalf("Budget(%q) = %d %v", label, got, ok)
		}
	}
}

func TestDoesNotStopWhatItCouldNotRecord(t *testing.T) {
	engine := &fakeEngine{stopped: map[string]int{}, containers: []docker.ContainerSummary{container("sk-over-1", "running", 100<<20, "67108864")}}
	state := &fakeState{intents: map[string]bool{}, reasons: map[string]string{}, fail: true}
	w, _ := watcher(engine, state)
	// Stopped without its intent recorded, the reconciler would start it again at once.
	if err := w.Pass(t.Context()); err == nil || len(engine.stopped) != 0 {
		t.Fatalf("stopped without recording the intent: %v %v", err, engine.stopped)
	}
}

func TestReportsFailuresWithoutDockerText(t *testing.T) {
	w, _ := watcher(&fakeEngine{listErr: errors.New("open /var/lib/docker/overlay2/secret-path: permission denied")}, &fakeState{})
	if err := w.Pass(t.Context()); err == nil || strings.Contains(err.Error(), "overlay2") {
		t.Fatalf("error %v", err)
	}
	engine := &fakeEngine{stopped: map[string]int{}, stopErr: errors.New("daemon detail"), containers: []docker.ContainerSummary{container("sk-over-1", "running", 100<<20, "67108864")}}
	w, _ = watcher(engine, &fakeState{intents: map[string]bool{}, reasons: map[string]string{}})
	if err := w.Pass(t.Context()); err == nil || strings.Contains(err.Error(), "daemon detail") {
		t.Fatalf("error %v", err)
	}
}

func TestRunStopsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	w, _ := watcher(&fakeEngine{stopped: map[string]int{}}, &fakeState{intents: map[string]bool{}, reasons: map[string]string{}})
	w.Interval = time.Millisecond
	go func() {
		defer close(done)
		w.Run(ctx)
	}()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the watcher outlived its context")
	}
}
