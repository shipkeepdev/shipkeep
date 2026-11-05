package actions

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

type containerConfirmer struct{ consumed *[]string }

func (c containerConfirmer) Consume(_ context.Context, token, action, target string) error {
	if token != wellformed || action != "container.remove" || target != "sk-api-r42" {
		return errors.New("rejected")
	}
	*c.consumed = append(*c.consumed, target)
	return nil
}

func withContainer(labels map[string]string) *fakeEngine {
	engine := newFakeEngine()
	container := docker.Container{ID: strings.Repeat("a", 64), Name: "/sk-api-r42"}
	container.Config.Labels = labels
	engine.containers = append(engine.containers, container)
	return engine
}

func lifecycle(t *testing.T, engine *fakeEngine, confirmations Confirmer, req *agentv1.ActionRequest) *agentv1.ActionUpdate {
	t.Helper()
	d := &Dispatcher{Journal: open(t), Handlers: DockerHandlers(engine, confirmations), Epoch: func() uint64 { return 3 }}
	req.ActionId, req.IdempotencyKey, req.LeaseEpoch = testID, "lifecycle", 3
	req.DeadlineUnixMs = time.Now().Add(time.Minute).UnixMilli()
	out := &recorder{}
	d.Handle(context.Background(), req, out.send)
	return out.last(t)
}

func TestLifecycleActsOnlyOnManagedContainers(t *testing.T) {
	managedLabels := map[string]string{docker.ManagedLabel: "true"}
	engine := withContainer(managedLabels)
	start := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_StartContainer{StartContainer: &agentv1.StartContainer{ContainerId: "sk-api-r42"}}}
	stop := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_StopContainer{StopContainer: &agentv1.StopContainer{ContainerId: "sk-api-r42", StopTimeout: durationpb.New(30 * time.Second)}}}
	remove := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveContainer{RemoveContainer: &agentv1.RemoveContainer{ContainerId: "sk-api-r42"}}}
	for _, req := range []*agentv1.ActionRequest{start, stop, remove} {
		if !succeeded(lifecycle(t, engine, nil, req)) {
			t.Fatalf("%v failed", req.GetAction())
		}
	}
	if len(engine.started) != 1 || len(engine.stopped) != 1 || engine.removedContainers[0] != strings.Repeat("a", 64)+":false" {
		t.Fatalf("calls: %v %v %v", engine.started, engine.stopped, engine.removedContainers)
	}
	// Gone: stop and remove are already done, start fails.
	if !succeeded(lifecycle(t, engine, nil, stop)) || !succeeded(lifecycle(t, engine, nil, remove)) || succeeded(lifecycle(t, engine, nil, start)) {
		t.Fatal("missing container handled incorrectly")
	}
	foreign := withContainer(nil)
	for _, req := range []*agentv1.ActionRequest{start, stop, remove} {
		if succeeded(lifecycle(t, foreign, nil, req)) {
			t.Fatal("touched an unmanaged container")
		}
	}
	if len(foreign.started)+len(foreign.stopped)+len(foreign.removedContainers) != 0 {
		t.Fatal("unmanaged container reached the daemon")
	}
}

func TestRemovingVolumesNeedsAConfirmationForThatContainer(t *testing.T) {
	var consumed []string
	engine := withContainer(map[string]string{docker.ManagedLabel: "true"})
	request := func(token string) *agentv1.ActionRequest {
		return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveContainer{RemoveContainer: &agentv1.RemoveContainer{ContainerId: "sk-api-r42", RemoveVolumes: true, ConfirmationToken: token}}}
	}
	if update := lifecycle(t, engine, containerConfirmer{&consumed}, request("")); update.GetError() != errInvalid {
		t.Fatalf("volume removal without token accepted: %v", update)
	}
	if !succeeded(lifecycle(t, engine, containerConfirmer{&consumed}, request(wellformed))) || len(consumed) != 1 ||
		engine.removedContainers[0] != strings.Repeat("a", 64)+":true" {
		t.Fatalf("confirmed removal failed: %v %v", consumed, engine.removedContainers)
	}
}

func TestLifecycleRejectsMaliciousReferences(t *testing.T) {
	for _, ref := range []string{"", "abc123", strings.Repeat("a", 63), "sk-api;rm", "../sk-api", "sk-API", "host", strings.Repeat("a", 64) + "/../x"} {
		for name, req := range map[string]*agentv1.ActionRequest{
			"start":  {Action: &agentv1.ActionRequest_StartContainer{StartContainer: &agentv1.StartContainer{ContainerId: ref}}},
			"stop":   {Action: &agentv1.ActionRequest_StopContainer{StopContainer: &agentv1.StopContainer{ContainerId: ref}}},
			"remove": {Action: &agentv1.ActionRequest_RemoveContainer{RemoveContainer: &agentv1.RemoveContainer{ContainerId: ref}}},
		} {
			engine := withContainer(map[string]string{docker.ManagedLabel: "true"})
			if update := lifecycle(t, engine, nil, req); update.GetError() != errInvalid {
				t.Fatalf("%s accepted %q", name, ref)
			}
		}
	}
	engine := withContainer(map[string]string{docker.ManagedLabel: "true"})
	for _, req := range []*agentv1.ActionRequest{
		{Action: &agentv1.ActionRequest_StopContainer{StopContainer: &agentv1.StopContainer{ContainerId: "sk-api-r42", StopTimeout: durationpb.New(time.Hour)}}},
		{Action: &agentv1.ActionRequest_RemoveContainer{RemoveContainer: &agentv1.RemoveContainer{ContainerId: "sk-api-r42", ConfirmationToken: wellformed}}},
	} {
		if update := lifecycle(t, engine, nil, req); update.GetError() != errInvalid {
			t.Fatalf("accepted %v", req.GetAction())
		}
	}
}
