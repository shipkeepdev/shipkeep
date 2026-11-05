package actions

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

const digest = "sha256:" + "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"

type fakeEngine struct {
	mu       sync.Mutex
	networks map[string]docker.Network
	volumes  map[string]docker.Volume
	images   map[string]docker.Image
	pulls    []string
	removed  []string

	containers        []docker.Container
	created           []docker.ContainerConfig
	started, stopped  []string
	removedContainers []string
	exitCode          int
	hang              bool
	auth              *docker.Auth
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{networks: map[string]docker.Network{}, volumes: map[string]docker.Volume{}, images: map[string]docker.Image{}}
}

func (f *fakeEngine) NetworkByName(_ context.Context, name string) (docker.Network, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if network, ok := f.networks[name]; ok {
		return network, nil
	}
	return docker.Network{}, docker.ErrNotFound
}

func (f *fakeEngine) CreateNetwork(_ context.Context, name string, _ bool, labels map[string]string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.networks[name] = docker.Network{ID: "net" + name, Name: name, Labels: labels}
	return "net" + name, nil
}

func (f *fakeEngine) Volume(_ context.Context, name string) (docker.Volume, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if volume, ok := f.volumes[name]; ok {
		return volume, nil
	}
	return docker.Volume{}, docker.ErrNotFound
}

func (f *fakeEngine) CreateVolume(_ context.Context, name string, labels map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.volumes[name] = docker.Volume{Name: name, Labels: labels}
	return nil
}

func (f *fakeEngine) RemoveVolume(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.volumes, name)
	f.removed = append(f.removed, name)
	return nil
}

func (f *fakeEngine) Container(_ context.Context, ref string) (docker.Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, container := range f.containers {
		if container.ID == ref || container.Name == "/"+ref {
			return container, nil
		}
	}
	return docker.Container{}, docker.ErrNotFound
}

func (f *fakeEngine) CreateContainer(_ context.Context, name string, config docker.ContainerConfig) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	container := docker.Container{ID: "c" + name, Name: "/" + name}
	container.Config.Labels = config.Labels
	f.containers = append(f.containers, container)
	f.created = append(f.created, config)
	return container.ID, nil
}

func (f *fakeEngine) StartContainer(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, id)
	return nil
}

func (f *fakeEngine) StopContainer(_ context.Context, id string, _ int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, id)
	return nil
}

func (f *fakeEngine) RemoveContainer(_ context.Context, id string, volumes bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers = slices.DeleteFunc(f.containers, func(c docker.Container) bool { return c.ID == id })
	f.removedContainers = append(f.removedContainers, fmt.Sprintf("%s:%t", id, volumes))
	return nil
}

func (f *fakeEngine) WaitContainer(ctx context.Context, _ string) (int, error) {
	if f.hang {
		<-ctx.Done()
		return 0, ctx.Err()
	}
	return f.exitCode, nil
}

func (f *fakeEngine) Image(_ context.Context, ref string) (docker.Image, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if image, ok := f.images[ref]; ok {
		return image, nil
	}
	return docker.Image{}, docker.ErrNotFound
}

func (f *fakeEngine) PullImage(_ context.Context, repository, digest string, auth *docker.Auth) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	ref := repository + "@" + digest
	f.pulls = append(f.pulls, ref)
	f.auth = auth
	f.images[ref] = docker.Image{ID: "img", RepoDigests: []string{ref}}
	return nil
}

func run(t *testing.T, engine Engine, req *agentv1.ActionRequest) *agentv1.ActionUpdate {
	t.Helper()
	d := &Dispatcher{Journal: open(t), Handlers: DockerHandlers(engine, confirmer{}, nil), Epoch: func() uint64 { return 3 }}
	req.ActionId = testID
	req.IdempotencyKey = "test:key"
	req.LeaseEpoch = 3
	req.DeadlineUnixMs = time.Now().Add(time.Minute).UnixMilli()
	out := &recorder{}
	d.Handle(context.Background(), req, out.send)
	return out.last(t)
}

func succeeded(update *agentv1.ActionUpdate) bool {
	return update.GetState() == agentv1.OperationState_OPERATION_STATE_SUCCEEDED
}

func TestEnsureNetworkCreatesOnceAndRefusesForeignNetworks(t *testing.T) {
	engine := newFakeEngine()
	update := run(t, engine, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureNetwork{EnsureNetwork: &agentv1.EnsureNetwork{Name: "sk-app-prod"}}})
	if !succeeded(update) || engine.networks["sk-app-prod"].Labels[docker.ManagedLabel] != "true" {
		t.Fatalf("network not created as managed: %v", update)
	}
	engine.networks["sk-foreign"] = docker.Network{ID: "x", Name: "sk-foreign"}
	if succeeded(run(t, engine, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureNetwork{EnsureNetwork: &agentv1.EnsureNetwork{Name: "sk-foreign"}}})) {
		t.Fatal("adopted a network Shipkeep does not manage")
	}
}

func TestPullImageRequiresDigestsAndScopedCredentials(t *testing.T) {
	engine := newFakeEngine()
	ref := "registry.internal:5000/acme/api@" + digest
	credentials := &agentv1.RegistryCredentials{Server: "registry.internal:5000", Username: "deploy", Password: "short-lived", ExpiresAt: timestamppb.New(time.Now().Add(time.Minute))}
	update := run(t, engine, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: ref, RegistryCredentials: credentials}}})
	if !succeeded(update) || update.GetResult().GetImageDigest() != digest || engine.auth == nil || engine.auth.Password.Expose() != "short-lived" {
		t.Fatalf("pull failed: %v", update)
	}
	if again := run(t, engine, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: ref}}}); !succeeded(again) || len(engine.pulls) != 1 {
		t.Fatal("present image was pulled again")
	}
}

func TestDockerHandlersRejectMaliciousInput(t *testing.T) {
	expired := &agentv1.RegistryCredentials{Server: "registry.internal", Username: "u", Password: "p", ExpiresAt: timestamppb.New(time.Now().Add(-time.Minute))}
	foreign := &agentv1.RegistryCredentials{Server: "evil.example.com", Username: "u", Password: "p", ExpiresAt: timestamppb.New(time.Now().Add(time.Minute))}
	cases := map[string]*agentv1.ActionRequest{}
	for _, name := range []string{"", "app", "sk-", "sk-../../etc", "sk-APP", "sk-app;rm -rf /", "sk-" + strings.Repeat("a", 61), "host", "bridge", "sk-app\n"} {
		cases["network "+name] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureNetwork{EnsureNetwork: &agentv1.EnsureNetwork{Name: name}}}
		cases["volume "+name] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureVolume{EnsureVolume: &agentv1.EnsureVolume{Name: name}}}
	}
	for _, ref := range []string{"nginx", "nginx:latest", "nginx:1.27", "NGINX@" + digest, "nginx@sha256:short", "../nginx@" + digest, "nginx@" + digest + " --privileged", strings.Repeat("a/", 300) + "x@" + digest} {
		cases["image "+ref] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: ref}}}
	}
	cases["expired credentials"] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: "registry.internal/app@" + digest, RegistryCredentials: expired}}}
	cases["credentials for another registry"] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: "registry.internal/app@" + digest, RegistryCredentials: foreign}}}
	cases["credentials for docker hub"] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: "app@" + digest, RegistryCredentials: foreign}}}
	for name, token := range map[string]string{"empty": "", "garbage": "not-a-token", "bad shape": "a.b.c"} {
		cases["remove volume token "+name] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveVolume{RemoveVolume: &agentv1.RemoveVolume{Name: "sk-data", ConfirmationToken: token}}}
	}
	cases["remove volume traversal"] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveVolume{RemoveVolume: &agentv1.RemoveVolume{Name: "sk-../etc", ConfirmationToken: wellformed}}}
	cases["reserved label"] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureVolume{EnsureVolume: &agentv1.EnsureVolume{Name: "sk-data", Labels: map[string]string{"sk.managed": "false"}}}}
	cases["control character label"] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureVolume{EnsureVolume: &agentv1.EnsureVolume{Name: "sk-data", Labels: map[string]string{"team": "a\x00b"}}}}
	many := map[string]string{}
	for i := range 17 {
		many[string(rune('a'+i))] = "x"
	}
	cases["too many labels"] = &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureVolume{EnsureVolume: &agentv1.EnsureVolume{Name: "sk-data", Labels: many}}}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			engine := newFakeEngine()
			update := run(t, engine, req)
			if update.GetState() != agentv1.OperationState_OPERATION_STATE_FAILED || update.GetError() != errInvalid {
				t.Fatalf("accepted malicious input: %v", update)
			}
			if len(engine.networks)+len(engine.volumes)+len(engine.pulls)+len(engine.removed) != 0 {
				t.Fatal("rejected input reached the daemon")
			}
		})
	}
}

func TestEnsureVolumeKeepsDataAndLabelsItsOwn(t *testing.T) {
	engine := newFakeEngine()
	req := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureVolume{EnsureVolume: &agentv1.EnsureVolume{Name: "sk-data", Labels: map[string]string{"app": "api"}}}}
	if !succeeded(run(t, engine, req)) {
		t.Fatal("volume not created")
	}
	if labels := engine.volumes["sk-data"].Labels; labels["app"] != "api" || labels[docker.ManagedLabel] != "true" {
		t.Fatalf("labels: %v", labels)
	}
	engine.volumes["sk-other"] = docker.Volume{Name: "sk-other"}
	if succeeded(run(t, engine, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureVolume{EnsureVolume: &agentv1.EnsureVolume{Name: "sk-other"}}})) {
		t.Fatal("adopted an unmanaged volume")
	}
}

func FuzzResourceAndImageValidation(f *testing.F) {
	for _, seed := range []string{"sk-app", "sk-../x", "registry/app@" + digest, "app:latest", "\x00", strings.Repeat("sk-", 40)} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, value string) {
		if _, err := ensureNetwork(newFakeEngine(), &agentv1.EnsureNetwork{Name: value}); err == nil &&
			(!strings.HasPrefix(value, "sk-") || len(value) > 63 || strings.ContainsAny(value, "/.\\ \n\x00;")) {
			t.Fatalf("accepted network name %q", value)
		}
		if _, err := pullImage(newFakeEngine(), &agentv1.PullImage{ImageRef: value}); err == nil &&
			(!strings.Contains(value, "@sha256:") || strings.ContainsAny(value, " \n\x00;\\") || strings.Contains(value, "..")) {
			t.Fatalf("accepted image reference %q", value)
		}
	})
}

// wellformed has the exact SPEC 3.6 shape; confirmer decides acceptance in these tests.
const wellformed = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwMTlkMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwZTEiLCJvcmciOiIwMTlkMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwZTIiLCJhY3Rpb24iOiJ2b2x1bWUucmVtb3ZlIiwidGFyZ2V0Ijoic2stZGF0YSIsInN1YiI6IjAxOWQwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDBlMyIsImlhdCI6MTc5Mzg4MDAwMCwiZXhwIjoxNzkzODgwMzAwfQ.UxepazWNLS8BkoQIdIOvf2ol7SO3x8yHnDG8Xkk9PElGRM7LHYCroY8z45b1d-tn_ZpuhrdEgeTWCnoKvcDTAg" // gitleaks:allow (test token, fixed public test key)

type confirmer struct{ reject bool }

func (c confirmer) Consume(_ context.Context, token, action, target string) error {
	if c.reject || token != wellformed || action != "volume.remove" || target != "sk-data" {
		return errors.New("rejected")
	}
	return nil
}

func TestRemoveVolumeNeedsConfirmationAndManagedVolume(t *testing.T) {
	remove := func(engine *fakeEngine, c Confirmer, name string) *agentv1.ActionUpdate {
		d := &Dispatcher{Journal: open(t), Handlers: DockerHandlers(engine, c, nil), Epoch: func() uint64 { return 3 }}
		out := &recorder{}
		d.Handle(context.Background(), &agentv1.ActionRequest{ActionId: testID, IdempotencyKey: "rm", LeaseEpoch: 3, DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
			Action: &agentv1.ActionRequest_RemoveVolume{RemoveVolume: &agentv1.RemoveVolume{Name: name, ConfirmationToken: wellformed}}}, out.send)
		return out.last(t)
	}
	engine := newFakeEngine()
	engine.volumes["sk-data"] = docker.Volume{Name: "sk-data", Labels: map[string]string{docker.ManagedLabel: "true"}}
	if succeeded(remove(engine, confirmer{reject: true}, "sk-data")) || len(engine.removed) != 0 {
		t.Fatal("removed without a valid confirmation")
	}
	if !succeeded(remove(engine, confirmer{}, "sk-data")) || len(engine.removed) != 1 {
		t.Fatal("confirmed removal failed")
	}
	foreign := newFakeEngine()
	foreign.volumes["sk-data"] = docker.Volume{Name: "sk-data"}
	if succeeded(remove(foreign, confirmer{}, "sk-data")) || len(foreign.removed) != 0 {
		t.Fatal("removed an unmanaged volume")
	}
}
