package reconcile

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
)

type engine struct {
	containers map[string]docker.Container
	started    []string
}

func (e *engine) Container(_ context.Context, ref string) (docker.Container, error) {
	container, ok := e.containers[ref]
	if !ok {
		return docker.Container{}, docker.ErrNotFound
	}
	return container, nil
}

func (e *engine) StartContainer(_ context.Context, id string) error {
	e.started = append(e.started, id)
	for name, container := range e.containers {
		if container.ID == id {
			container.State.Running, container.State.Status = true, "running"
			e.containers[name] = container
		}
	}
	return nil
}

func container(name string, managed, running bool) docker.Container {
	c := docker.Container{ID: strings.Repeat("c", 63) + name[len(name)-1:], Name: "/" + name}
	if managed {
		c.Config.Labels = map[string]string{docker.ManagedLabel: "true"}
	}
	c.State.Running = running
	c.State.Status = map[bool]string{true: "running", false: "exited"}[running]
	return c
}

func TestPassRestartsOnlyManagedContainersThatShouldRun(t *testing.T) {
	store, err := journal.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	ctx := context.Background()
	now := time.Now()
	for name, running := range map[string]bool{"sk-crashed-1": true, "sk-stopped-2": false, "sk-gone-3": true, "sk-foreign-4": true, "sk-healthy-5": true} {
		if err := store.SetIntent(ctx, name, running, now); err != nil {
			t.Fatal(err)
		}
	}
	e := &engine{containers: map[string]docker.Container{
		"sk-crashed-1": container("sk-crashed-1", true, false),
		"sk-stopped-2": container("sk-stopped-2", true, false),
		"sk-foreign-4": container("sk-foreign-4", false, false),
		"sk-healthy-5": container("sk-healthy-5", true, true),
	}}
	r := Reconciler{Engine: e, State: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := r.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if len(e.started) != 1 || e.started[0] != e.containers["sk-crashed-1"].ID {
		t.Fatalf("restarted %v, want only the crashed container", e.started)
	}
	status, _, err := store.Actual(ctx, "sk-crashed-1")
	if err != nil || status.GetState().String() != "STATE_RUNNING" {
		t.Fatalf("observation not recorded: %v %v", status, err)
	}
	if err := store.ClearIntent(ctx, "sk-crashed-1"); err != nil {
		t.Fatal(err)
	}
	intents, _ := store.Intents(ctx)
	if _, ok := intents["sk-crashed-1"]; ok || len(intents) != 4 {
		t.Fatalf("intents: %v", intents)
	}
	if err := store.SetIntent(ctx, "../etc", true, now); err == nil {
		t.Fatal("accepted an invalid container name")
	}
}
