//go:build integration

package actions

// What a failed action in the real tests says about its cause (#517). The dispatcher answers a
// fixed text and the journal keeps no error text, by design: the tests therefore record what
// Docker answered the handlers, and read Docker's state of the test's containers.

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
)

// recordingEngine is the agent's engine, recording every error Docker answered but "not found",
// which the handlers ask for and expect.
type recordingEngine struct {
	Engine
	mu     sync.Mutex
	errors []string
}

func (e *recordingEngine) record(call string, err error) error {
	if err != nil && !errors.Is(err, docker.ErrNotFound) {
		e.mu.Lock()
		e.errors = append(e.errors, call+": "+err.Error())
		e.mu.Unlock()
	}
	return err
}

func (e *recordingEngine) recorded() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.errors)
}

func (e *recordingEngine) NetworkByName(ctx context.Context, name string) (docker.Network, error) {
	network, err := e.Engine.NetworkByName(ctx, name)
	return network, e.record("network "+name, err)
}

func (e *recordingEngine) CreateNetwork(ctx context.Context, name string, internal bool, labels map[string]string) (string, error) {
	id, err := e.Engine.CreateNetwork(ctx, name, internal, labels)
	return id, e.record("create network "+name, err)
}

func (e *recordingEngine) Volume(ctx context.Context, name string) (docker.Volume, error) {
	volume, err := e.Engine.Volume(ctx, name)
	return volume, e.record("volume "+name, err)
}

func (e *recordingEngine) CreateVolume(ctx context.Context, name string, labels map[string]string) error {
	return e.record("create volume "+name, e.Engine.CreateVolume(ctx, name, labels))
}

func (e *recordingEngine) RemoveVolume(ctx context.Context, name string) error {
	return e.record("remove volume "+name, e.Engine.RemoveVolume(ctx, name))
}

func (e *recordingEngine) Image(ctx context.Context, ref string) (docker.Image, error) {
	image, err := e.Engine.Image(ctx, ref)
	return image, e.record("image "+ref, err)
}

func (e *recordingEngine) PullImage(ctx context.Context, repository, digest string, auth *docker.Auth) error {
	return e.record("pull "+repository+"@"+digest, e.Engine.PullImage(ctx, repository, digest, auth))
}

func (e *recordingEngine) Proxies(ctx context.Context) (docker.Proxies, error) {
	proxies, err := e.Engine.Proxies(ctx)
	return proxies, e.record("proxies", err)
}

func (e *recordingEngine) Container(ctx context.Context, ref string) (docker.Container, error) {
	container, err := e.Engine.Container(ctx, ref)
	return container, e.record("container "+ref, err)
}

func (e *recordingEngine) CreateContainer(ctx context.Context, name string, config docker.ContainerConfig) (string, error) {
	id, err := e.Engine.CreateContainer(ctx, name, config)
	return id, e.record("create container "+name, err)
}

func (e *recordingEngine) StartContainer(ctx context.Context, id string) error {
	return e.record("start container "+id, e.Engine.StartContainer(ctx, id))
}

func (e *recordingEngine) StopContainer(ctx context.Context, id string, timeout int) error {
	return e.record("stop container "+id, e.Engine.StopContainer(ctx, id, timeout))
}

func (e *recordingEngine) RemoveContainer(ctx context.Context, id string, volumes bool) error {
	return e.record("remove container "+id, e.Engine.RemoveContainer(ctx, id, volumes))
}

func (e *recordingEngine) WaitContainer(ctx context.Context, id string) (int, error) {
	code, err := e.Engine.WaitContainer(ctx, id)
	return code, e.record("wait container "+id, err)
}

// explain is what a failed action's test prints: Docker's answers to the handlers, and Docker's
// state of each container the test created.
func (a *realAgent) explain() string {
	var out strings.Builder
	out.WriteString("Docker's errors to the agent:")
	errs := a.recording.recorded()
	if len(errs) == 0 {
		out.WriteString(" none")
	}
	for _, line := range errs {
		out.WriteString("\n  " + line)
	}
	out.WriteString("\nThe test's containers:")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, name := range a.names {
		view, err := a.view(ctx, name)
		if err != nil {
			fmt.Fprintf(&out, "\n  %s: %v", name, err)
			continue
		}
		state := view.State
		fmt.Fprintf(&out, "\n  %s: %s, exit code %d, OOM killed %t, error %q", name, state.Status, state.ExitCode, state.OOMKilled, state.Error)
	}
	return out.String()
}
