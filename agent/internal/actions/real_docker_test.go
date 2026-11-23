//go:build integration

package actions

// Acceptance of M1.4 against a real Docker daemon (#16): every container action goes through the
// agent's own handlers and Engine API client, and Docker's view of the result is checked. Run with
// `go test -tags integration ./agent/internal/actions/`; the CI job "Agent against Docker and
// Caddy" does. SHIPKEEP_IT_DOCKER names the daemon socket (default /var/run/docker.sock).

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Small public images, pinned by digest as the agent requires, and named as the control plane names
// Docker Hub images: without the host, as Docker records them (image-reference.ts).
const (
	whoamiImage  = "traefik/whoami@sha256:43a68d10b9dfcfc3ffbfe4dd42100dc9aeaf29b3a5636c856337a5940f1b4f1c"
	busyboxImage = "busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"
	// itNetwork is created by the test, or by the CI job beforehand with the managed label, so that
	// the Caddy it starts there reaches the test's containers.
	itNetwork = "sk-it"
)

// acceptAll stands for the confirmation verifier, whose tokens have their own tests (confirm).
type acceptAll struct{}

func (acceptAll) Consume(context.Context, string, string, string) error { return nil }

// realAgent sends actions through the agent's dispatcher, one journal for the whole test, as the
// agent does, with each action under its own id and idempotency key.
type realAgent struct {
	t          *testing.T
	socket     string
	engine     *docker.Client
	store      *journal.Store
	dispatcher *Dispatcher
	count      int
}

func newRealAgent(t *testing.T, extra map[string]Handler) *realAgent {
	t.Helper()
	socket := os.Getenv("SHIPKEEP_IT_DOCKER")
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	engine, err := docker.New("unix://" + socket)
	if err != nil {
		t.Fatal(err)
	}
	store := open(t)
	// No egress proxy in front of this daemon: the egress check has its own tests (#351).
	handlers := DockerHandlers(engine, acceptAll{}, store, WithoutEgressCheck())
	for kind, handler := range extra {
		handlers[kind] = handler
	}
	return &realAgent{t: t, socket: socket, engine: engine, store: store, dispatcher: &Dispatcher{Journal: store, Handlers: handlers, Epoch: func() uint64 { return 1 }}}
}

func (a *realAgent) send(req *agentv1.ActionRequest, timeout time.Duration) *agentv1.ActionUpdate {
	a.t.Helper()
	a.count++
	req.ActionId = "019d0000-0000-7000-8000-" + strings.Repeat("0", 8) + fourDigits(a.count)
	req.IdempotencyKey = "it:" + fourDigits(a.count)
	req.LeaseEpoch = 1
	req.DeadlineUnixMs = time.Now().Add(timeout).UnixMilli()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out := &recorder{}
	a.dispatcher.Handle(ctx, req, out.send)
	return out.last(a.t)
}

func fourDigits(n int) string {
	digits := []byte("0000")
	for i := 3; i >= 0 && n > 0; i-- {
		digits[i] = byte('0' + n%10)
		n /= 10
	}
	return string(digits)
}

// must sends an action that has to succeed, and fails the test with Docker's answer otherwise.
func (a *realAgent) must(name string, req *agentv1.ActionRequest, timeout time.Duration) *agentv1.ActionUpdate {
	a.t.Helper()
	update := a.send(req, timeout)
	if !succeeded(update) {
		a.t.Fatalf("%s: %v", name, update)
	}
	return update
}

// forget removes what a test left in Docker, whatever state it is in.
func (a *realAgent) forget(containers []string, volumes []string) {
	a.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		for _, name := range containers {
			if container, err := a.engine.Container(ctx, name); err == nil {
				_ = a.engine.StopContainer(ctx, container.ID, 1)
				_ = a.engine.RemoveContainer(ctx, container.ID, false)
			}
		}
		for _, name := range volumes {
			_ = a.engine.RemoveVolume(ctx, name)
		}
	})
}

// dockerView is what Docker reports of a container, read here without the agent's client, which
// only reads what the agent itself needs.
type dockerView struct {
	Config struct {
		User string `json:"User"`
	} `json:"Config"`
	HostConfig struct {
		Privileged     bool     `json:"Privileged"`
		Binds          []string `json:"Binds"`
		PidMode        string   `json:"PidMode"`
		UsernsMode     string   `json:"UsernsMode"`
		NetworkMode    string   `json:"NetworkMode"`
		SecurityOpt    []string `json:"SecurityOpt"`
		ReadonlyRootfs bool     `json:"ReadonlyRootfs"`
		Memory         int64    `json:"Memory"`
		NanoCpus       int64    `json:"NanoCpus"`
		PidsLimit      int64    `json:"PidsLimit"`
		IpcMode        string   `json:"IpcMode"`
		Init           bool     `json:"Init"`
		Mounts         []struct {
			Type string `json:"Type"`
		} `json:"Mounts"`
	} `json:"HostConfig"`
}

func (a *realAgent) inspect(id string) dockerView {
	a.t.Helper()
	client := http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", a.socket)
	}}}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://docker/containers/"+url.PathEscape(id)+"/json", nil)
	if err != nil {
		a.t.Fatal(err)
	}
	response, err := client.Do(request)
	if err != nil {
		a.t.Fatal(err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	var view dockerView
	if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
		a.t.Fatal(err)
	}
	return view
}

func whoamiSpec(name, version string) *agentv1.ContainerSpec {
	return &agentv1.ContainerSpec{
		Name:     name,
		ImageRef: whoamiImage,
		// A port above 1024, so the container needs no capability as a non-root user.
		Env:            []*agentv1.EnvVar{{Name: "WHOAMI_PORT_NUMBER", Value: "8080"}, {Name: "WHOAMI_NAME", Value: version}},
		Ports:          []*agentv1.PortMapping{{ContainerPort: 8080}},
		Resources:      &agentv1.Resources{CpuMillis: 250, MemoryBytes: 64 << 20, DiskBytes: 64 << 20},
		Network:        itNetwork,
		User:           "65534:65534",
		ReadOnlyRootfs: true,
	}
}

func itCreate(spec *agentv1.ContainerSpec) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_CreateContainer{CreateContainer: &agentv1.CreateContainer{Spec: spec}}}
}

func itStart(id string) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_StartContainer{StartContainer: &agentv1.StartContainer{ContainerId: id}}}
}

func itHealth(id string) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_HealthCheck{HealthCheck: &agentv1.HealthCheck{
		ContainerId: id,
		Spec: &agentv1.HealthCheckSpec{
			Probe:            &agentv1.HealthCheckSpec_HttpPath{HttpPath: "/"},
			Interval:         durationpb.New(time.Second),
			Timeout:          durationpb.New(time.Second),
			HealthyThreshold: 2,
		},
		Deadline: durationpb.New(time.Minute),
	}}}
}

func itStop(id string) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_StopContainer{StopContainer: &agentv1.StopContainer{ContainerId: id, StopTimeout: durationpb.New(5 * time.Second)}}}
}

func itRemove(id string) *agentv1.ActionRequest {
	return &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveContainer{RemoveContainer: &agentv1.RemoveContainer{ContainerId: id}}}
}

// prepare ensures the network and pulls both images, as a deployment does first.
func (a *realAgent) prepare() {
	a.t.Helper()
	a.must("ensure network", &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureNetwork{EnsureNetwork: &agentv1.EnsureNetwork{Name: itNetwork}}}, time.Minute)
	for _, image := range []string{whoamiImage, busyboxImage} {
		a.must("pull "+image, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: image}}}, 5*time.Minute)
	}
}

func TestRealDockerRunsEveryContainerAction(t *testing.T) {
	agent := newRealAgent(t, nil)
	const name, volume = "sk-it-api-r1-0", "sk-it-api-data"
	agent.forget([]string{name, "sk-it-api-r1-release-ok", "sk-it-api-r1-release-fail", "sk-it-traversal"}, []string{volume})
	agent.prepare()
	// Pulling again finds the image already there.
	agent.must("pull again", &agentv1.ActionRequest{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{ImageRef: whoamiImage}}}, time.Minute)
	agent.must("ensure volume", &agentv1.ActionRequest{Action: &agentv1.ActionRequest_EnsureVolume{EnsureVolume: &agentv1.EnsureVolume{Name: volume}}}, time.Minute)

	// The release command runs to its end, and its exit code comes back, whatever it is.
	for name, release := range map[string]struct {
		command []string
		code    int32
	}{"sk-it-api-r1-release-ok": {[]string{"true"}, 0}, "sk-it-api-r1-release-fail": {[]string{"false"}, 1}} {
		spec := &agentv1.ContainerSpec{Name: name, ImageRef: busyboxImage, Command: release.command, Resources: &agentv1.Resources{CpuMillis: 250, MemoryBytes: 64 << 20}, Network: itNetwork}
		update := agent.must("release "+name, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RunReleaseTask{RunReleaseTask: &agentv1.RunReleaseTask{Spec: spec, Timeout: durationpb.New(time.Minute)}}}, 2*time.Minute)
		if code := update.GetResult().GetReleaseTask().GetExitCode(); code != release.code {
			t.Fatalf("%s exited with %d, want %d", name, code, release.code)
		}
	}

	spec := whoamiSpec(name, "v1")
	spec.Mounts = []*agentv1.Mount{
		{ContainerPath: "/data", Source: &agentv1.Mount_VolumeName{VolumeName: volume}},
		{ContainerPath: "/tmp", Source: &agentv1.Mount_Tmpfs_{Tmpfs: &agentv1.Mount_Tmpfs{SizeBytes: 16 << 20}}},
	}
	id := agent.must("create", itCreate(spec), time.Minute).GetResult().GetContainerId()
	// Creating the same spec again finds the container it made.
	if again := agent.must("create again", itCreate(spec), time.Minute).GetResult().GetContainerId(); again != id {
		t.Fatalf("a second create made another container: %s, then %s", id, again)
	}
	agent.must("start", itStart(id), time.Minute)
	if result := agent.must("health check", itHealth(id), 2*time.Minute).GetResult().GetHealthCheck(); !result.GetHealthy() {
		t.Fatalf("whoami is not healthy: %v", result)
	}

	// What Docker runs is what the agent decided, and nothing more (SPEC 3.3, THREAT_MODEL E1).
	ctx := context.Background()
	container, err := agent.engine.Container(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if !container.State.Running || container.Config.Labels[docker.ManagedLabel] != "true" {
		t.Fatalf("container not running as decided: running=%v labels=%v", container.State.Running, container.Config.Labels)
	}
	inspected := agent.inspect(id)
	host := inspected.HostConfig
	if host.Privileged || len(host.Binds) > 0 || host.PidMode != "" || host.UsernsMode != "" || host.NetworkMode != itNetwork ||
		!slices.Contains(host.SecurityOpt, "no-new-privileges=true") || !host.ReadonlyRootfs || host.Memory != 64<<20 ||
		host.NanoCpus != 250_000_000 || host.PidsLimit != defaultPids || host.IpcMode != "private" || !host.Init {
		t.Fatalf("confinement not applied by Docker: %+v", host)
	}
	if inspected.Config.User != "65534:65534" {
		t.Fatalf("not running as the user asked for: %q", inspected.Config.User)
	}
	for _, mount := range host.Mounts {
		if mount.Type != "volume" && mount.Type != "tmpfs" {
			t.Fatalf("Docker holds a %s mount", mount.Type)
		}
	}

	// A path outside the allowed set never reaches Docker.
	traversal := whoamiSpec("sk-it-traversal", "x")
	traversal.Mounts = []*agentv1.Mount{{ContainerPath: "/data/../../etc", Source: &agentv1.Mount_VolumeName{VolumeName: volume}}}
	if update := agent.send(itCreate(traversal), time.Minute); update.GetError() != errInvalid {
		t.Fatalf("path traversal accepted: %v", update)
	}
	if _, err := agent.engine.Container(ctx, "sk-it-traversal"); !errors.Is(err, docker.ErrNotFound) {
		t.Fatalf("a refused container exists in Docker: %v", err)
	}

	agent.must("stop", itStop(id), time.Minute)
	if container, err := agent.engine.Container(ctx, id); err != nil || container.State.Running {
		t.Fatalf("container still running after stop: %v", err)
	}
	// Stopping again is done; the reconciler would not start it: its intent was cleared first.
	agent.must("stop again", itStop(id), time.Minute)
	if intents, err := agent.store.Intents(ctx); err != nil || intents[name] {
		t.Fatalf("a stopped container is still meant to run: %v %v", intents, err)
	}
	agent.must("remove", itRemove(id), time.Minute)
	if _, err := agent.engine.Container(ctx, id); !errors.Is(err, docker.ErrNotFound) {
		t.Fatalf("container still in Docker after remove: %v", err)
	}
	// The data outlives the container; removing it needs a confirmation.
	if _, err := agent.engine.Volume(ctx, volume); err != nil {
		t.Fatalf("the volume went with the container: %v", err)
	}
	agent.must("remove volume", &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveVolume{RemoveVolume: &agentv1.RemoveVolume{Name: volume, ConfirmationToken: wellformed}}}, time.Minute)
	if _, err := agent.engine.Volume(ctx, volume); !errors.Is(err, docker.ErrNotFound) {
		t.Fatalf("volume still in Docker: %v", err)
	}
}
