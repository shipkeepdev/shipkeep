package actions

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

func validSpec() *agentv1.ContainerSpec {
	return &agentv1.ContainerSpec{
		Name:      "sk-api-r42",
		ImageRef:  "registry.internal:5000/acme/api@" + digest,
		Command:   []string{"node", "dist/main.js"},
		Env:       []*agentv1.EnvVar{{Name: "LOG_LEVEL", Value: "info"}},
		Secrets:   []*agentv1.SecretEnv{{Name: "DATABASE_URL", Version: 3, Value: []byte("postgres://private-secret")}},
		Ports:     []*agentv1.PortMapping{{ContainerPort: 8080}},
		Mounts:    []*agentv1.Mount{{ContainerPath: "/app/uploads", Source: &agentv1.Mount_VolumeName{VolumeName: "sk-uploads"}}, {ContainerPath: "/tmp", Source: &agentv1.Mount_Tmpfs_{Tmpfs: &agentv1.Mount_Tmpfs{SizeBytes: 64 << 20}}}},
		Resources: &agentv1.Resources{CpuMillis: 500, MemoryBytes: 512 << 20},
		Labels:    map[string]string{"app": "api"},
		Network:   "sk-acme-prod",
		User:      "1000:1000",
		CapAdd:    []agentv1.Capability{agentv1.Capability_CAPABILITY_NET_BIND_SERVICE},
	}
}

func create(t *testing.T, engine *fakeEngine, spec *agentv1.ContainerSpec) *agentv1.ActionUpdate {
	t.Helper()
	return run(t, engine, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_CreateContainer{CreateContainer: &agentv1.CreateContainer{Spec: spec}}})
}

// Without exactly one TCP port in the spec, no port is recorded: the probe never guesses.
func TestCreateContainerRecordsTheProbePortOnlyWhenItIsKnown(t *testing.T) {
	for name, ports := range map[string][]*agentv1.PortMapping{
		"no port":   nil,
		"two ports": {{ContainerPort: 8080}, {ContainerPort: 9090}},
		"udp only":  {{ContainerPort: 5353, Protocol: agentv1.PortMapping_PROTOCOL_UDP}},
	} {
		engine := newFakeEngine()
		spec := validSpec()
		spec.Ports = ports
		if update := create(t, engine, spec); !succeeded(update) {
			t.Fatalf("%s: create failed: %v", name, update)
		}
		if label, ok := engine.created[0].Labels[ProbePortLabel]; ok {
			t.Fatalf("%s: probe port %q recorded", name, label)
		}
	}
}

func TestCreateContainerSendsOnlyConfinedSettings(t *testing.T) {
	engine := newFakeEngine()
	if update := create(t, engine, validSpec()); !succeeded(update) || update.GetResult().GetContainerId() != "csk-api-r42" {
		t.Fatalf("create failed: %v", update)
	}
	config := engine.created[0]
	host := config.HostConfig
	if host.NetworkMode != "sk-acme-prod" || !slices.Equal(host.SecurityOpt, []string{"no-new-privileges=true"}) ||
		host.PidsLimit != defaultPids || host.IpcMode != "private" || !slices.Equal(host.CapAdd, []string{"NET_BIND_SERVICE"}) ||
		host.NanoCPUs != 500_000_000 || host.Memory != 512<<20 || host.RestartPolicy.Name != "unless-stopped" {
		t.Fatalf("unexpected host config: %+v", host)
	}
	for _, mount := range host.Mounts {
		if mount.Type != "volume" && mount.Type != "tmpfs" {
			t.Fatalf("unexpected mount type %q", mount.Type)
		}
	}
	if _, ok := config.ExposedPorts["8080/tcp"]; !ok {
		t.Fatal("port not exposed on the network")
	}
	if config.Labels[docker.ManagedLabel] != "true" || config.Labels[identityLabel] != "sk-api-r42" || len(config.Labels[specLabel]) != 64 ||
		config.Labels[ProbePortLabel] != "8080" {
		t.Fatalf("labels: %v", config.Labels)
	}
	if !slices.Contains(config.Env, "DATABASE_URL=postgres://private-secret") {
		t.Fatal("secret environment missing")
	}
	for key, value := range config.Labels {
		if strings.Contains(key+value, "private-secret") {
			t.Fatal("secret value leaked into a label")
		}
	}
}

func TestCreateContainerIsIdempotentAndRefusesConflicts(t *testing.T) {
	engine := newFakeEngine()
	for range 2 {
		if !succeeded(create(t, engine, validSpec())) {
			t.Fatal("create or replay failed")
		}
	}
	if len(engine.created) != 1 {
		t.Fatalf("replay created %d containers", len(engine.created))
	}
	// Rotating a secret value under the same version keeps the fingerprint: drift is tracked by version.
	rotated := validSpec()
	rotated.Secrets[0].Value = []byte("other")
	if !succeeded(create(t, engine, rotated)) {
		t.Fatal("same version was treated as a conflict")
	}
	// The name is taken: the control plane hears it as such (issue #501, a restore reusing a
	// release number), not as an unexplained failure.
	const taken = "a container with this name already exists on the server"
	changed := validSpec()
	changed.Command = []string{"node", "other.js"}
	if update := create(t, engine, changed); succeeded(update) || len(engine.created) != 1 || update.GetError() != taken {
		t.Fatalf("different spec reused or replaced an existing container, or failed without its cause: %q", update.GetError())
	}
	foreign := newFakeEngine()
	foreign.containers = append(foreign.containers, docker.Container{ID: "x", Name: "/sk-api-r42"})
	if update := create(t, foreign, validSpec()); succeeded(update) || len(foreign.created) != 0 || update.GetError() != taken {
		t.Fatalf("adopted an unmanaged container, or failed without its cause: %q", update.GetError())
	}
}

func TestCreateContainerRejectsMaliciousSpecs(t *testing.T) {
	mutations := map[string]func(*agentv1.ContainerSpec){
		"tagged image":    func(s *agentv1.ContainerSpec) { s.ImageRef = "nginx:latest" },
		"host network":    func(s *agentv1.ContainerSpec) { s.Network = "host" },
		"bad name":        func(s *agentv1.ContainerSpec) { s.Name = "../sk-api" },
		"root mount":      func(s *agentv1.ContainerSpec) { s.Mounts[0].ContainerPath = "/" },
		"etc mount":       func(s *agentv1.ContainerSpec) { s.Mounts[0].ContainerPath = "/etc/passwd" },
		"proc mount":      func(s *agentv1.ContainerSpec) { s.Mounts[0].ContainerPath = "/proc/sys" },
		"docker socket":   func(s *agentv1.ContainerSpec) { s.Mounts[0].ContainerPath = "/var/run/docker.sock" },
		"relative mount":  func(s *agentv1.ContainerSpec) { s.Mounts[0].ContainerPath = "app/data" },
		"traversal mount": func(s *agentv1.ContainerSpec) { s.Mounts[0].ContainerPath = "/app/../etc" },
		"duplicate mount": func(s *agentv1.ContainerSpec) { s.Mounts[1].ContainerPath = "/app/uploads" },
		"foreign volume": func(s *agentv1.ContainerSpec) {
			s.Mounts[0].Source = &agentv1.Mount_VolumeName{VolumeName: "/var/lib/docker"}
		},
		"empty mount source": func(s *agentv1.ContainerSpec) { s.Mounts[0].Source = nil },
		"huge tmpfs": func(s *agentv1.ContainerSpec) {
			s.Mounts[1].Source = &agentv1.Mount_Tmpfs_{Tmpfs: &agentv1.Mount_Tmpfs{SizeBytes: 2 << 30}}
		},
		"env injection":      func(s *agentv1.ContainerSpec) { s.Env[0].Name = "A=B" },
		"env NUL":            func(s *agentv1.ContainerSpec) { s.Env[0].Value = "a\x00b" },
		"duplicate env":      func(s *agentv1.ContainerSpec) { s.Secrets[0].Name = "LOG_LEVEL" },
		"oversized secret":   func(s *agentv1.ContainerSpec) { s.Secrets[0].Value = make([]byte, maxSecretValue+1) },
		"secrets as files":   func(s *agentv1.ContainerSpec) { s.SecretsAsFiles = true },
		"too many arguments": func(s *agentv1.ContainerSpec) { s.Command = make([]string, maxCommand+1) },
		"NUL argument":       func(s *agentv1.ContainerSpec) { s.Command = []string{"sh\x00-c"} },
		"user injection":     func(s *agentv1.ContainerSpec) { s.User = "root;id" },
		"dns list in one":    func(s *agentv1.ContainerSpec) { s.DnsServers = []string{"8.8.8.8 1.1.1.1"} },
		"unknown capability": func(s *agentv1.ContainerSpec) { s.CapAdd = []agentv1.Capability{99} },
		"unspecified cap": func(s *agentv1.ContainerSpec) {
			s.CapAdd = []agentv1.Capability{agentv1.Capability_CAPABILITY_UNSPECIFIED}
		},
		"published host port": func(s *agentv1.ContainerSpec) { s.Ports[0].HostPort = 80 },
		"port zero":           func(s *agentv1.ContainerSpec) { s.Ports[0].ContainerPort = 0 },
		"reserved label":      func(s *agentv1.ContainerSpec) { s.Labels["sk.managed"] = "false" },
		"cpu overflow":        func(s *agentv1.ContainerSpec) { s.Resources.CpuMillis = maxCPUMillis + 1 },
		"memory overflow":     func(s *agentv1.ContainerSpec) { s.Resources.MemoryBytes = maxMemoryBytes + 1 },
		// A container without a CPU or a memory limit could starve its node (#301).
		"no resources":    func(s *agentv1.ContainerSpec) { s.Resources = nil },
		"empty resources": func(s *agentv1.ContainerSpec) { s.Resources = &agentv1.Resources{PidsLimit: 64} },
		"no cpu limit":    func(s *agentv1.ContainerSpec) { s.Resources.CpuMillis = 0 },
		"no memory limit": func(s *agentv1.ContainerSpec) { s.Resources.MemoryBytes = 0 },
		// A disk budget outside 64 MiB to 1 TiB (ADR 0022), and a forged budget label.
		"tiny disk budget":   func(s *agentv1.ContainerSpec) { s.Resources.DiskBytes = minDiskBytes - 1 },
		"huge disk budget":   func(s *agentv1.ContainerSpec) { s.Resources.DiskBytes = maxDiskBytes + 1 },
		"max uint64 disk":    func(s *agentv1.ContainerSpec) { s.Resources.DiskBytes = ^uint64(0) },
		"forged disk label":  func(s *agentv1.ContainerSpec) { s.Labels[DiskBudgetLabel] = "999999999999999" },
		"stop timeout of 1h": func(s *agentv1.ContainerSpec) { s.StopTimeout = durationpb.New(time.Hour) },
		"restart storm": func(s *agentv1.ContainerSpec) {
			s.RestartPolicy = &agentv1.RestartPolicy{Mode: agentv1.RestartPolicy_MODE_ON_FAILURE, MaxRestarts: 1000}
		},
		"relative working dir": func(s *agentv1.ContainerSpec) { s.WorkingDir = "app" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			spec := validSpec()
			mutate(spec)
			engine := newFakeEngine()
			update := create(t, engine, spec)
			if update.GetState() != agentv1.OperationState_OPERATION_STATE_FAILED || update.GetError() != errInvalid || len(engine.created) != 0 {
				t.Fatalf("accepted malicious spec: %v", update)
			}
		})
	}
	if create(t, newFakeEngine(), nil).GetError() != errInvalid {
		t.Fatal("missing spec accepted")
	}
}

func TestSpecFingerprintIgnoresSecretValuesOnly(t *testing.T) {
	a, b := validSpec(), validSpec()
	b.Secrets[0].Value = []byte("rotated")
	first, _ := specFingerprint(a)
	second, _ := specFingerprint(b)
	b.Secrets[0].Version = 4
	third, _ := specFingerprint(b)
	if first != second || first == third || !proto.Equal(a, validSpec()) {
		t.Fatal("fingerprint must follow versions, not values, and never mutate the spec")
	}
}

func FuzzMountTargets(f *testing.F) {
	for _, seed := range []string{"/app", "/", "/etc", "/proc/1", "/a/../etc", "relative", "/var/run/docker.sock", "/app//x", "/app\x00"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, target string) {
		mounts, err := containerMounts([]*agentv1.Mount{{ContainerPath: target, Source: &agentv1.Mount_VolumeName{VolumeName: "sk-data"}}})
		if err != nil {
			return
		}
		got := mounts[0].Target
		if !strings.HasPrefix(got, "/") || got == "/" || strings.Contains(got, "..") || strings.ContainsRune(got, 0) || underForbidden(got) {
			t.Fatalf("accepted mount target %q", got)
		}
	})
}

func TestContainersCarryTheirDiskBudget(t *testing.T) {
	for _, test := range []struct {
		name  string
		bytes uint64
		label string
	}{
		{"budget", 1 << 30, "1073741824"},
		{"smallest budget", minDiskBytes, "67108864"},
		{"largest budget", maxDiskBytes, "1099511627776"},
		// From a control plane older than the field: no budget, and no label to enforce.
		{"no budget", 0, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			spec := validSpec()
			spec.Resources.DiskBytes = test.bytes
			engine := newFakeEngine()
			if update := create(t, engine, spec); update.GetState() != agentv1.OperationState_OPERATION_STATE_SUCCEEDED {
				t.Fatalf("refused: %v", update)
			}
			if len(engine.created) != 1 {
				t.Fatalf("created %d containers", len(engine.created))
			}
			for _, config := range engine.created {
				label, present := config.Labels[DiskBudgetLabel]
				if label != test.label || present != (test.label != "") {
					t.Fatalf("label %q (present %v), want %q", label, present, test.label)
				}
			}
		})
	}
}

func TestReadOnlyRootGetsItsTmpfs(t *testing.T) {
	spec := validSpec()
	spec.ReadOnlyRootfs = true
	spec.Mounts = []*agentv1.Mount{{ContainerPath: "/tmp", Source: &agentv1.Mount_Tmpfs_{Tmpfs: &agentv1.Mount_Tmpfs{SizeBytes: 64 << 20, Mode: 0o1777}}}}
	engine := newFakeEngine()
	engine.images[spec.GetImageRef()] = docker.Image{}
	if update := create(t, engine, spec); update.GetState() != agentv1.OperationState_OPERATION_STATE_SUCCEEDED {
		t.Fatalf("refused: %v", update)
	}
	for _, config := range engine.created {
		if !config.HostConfig.ReadonlyRootfs || len(config.HostConfig.Mounts) != 1 || config.HostConfig.Mounts[0].Type != "tmpfs" || config.HostConfig.Mounts[0].Target != "/tmp" {
			t.Fatalf("not a read-only root with /tmp: %+v", config.HostConfig)
		}
	}
}

func TestReadOnlyRootRefusesUndeclaredImageVolumes(t *testing.T) {
	image := func(paths ...string) docker.Image {
		var declared docker.Image
		declared.Config.Volumes = map[string]struct{}{}
		for _, path := range paths {
			declared.Config.Volumes[path] = struct{}{}
		}
		return declared
	}
	for _, test := range []struct {
		name     string
		readOnly bool
		image    docker.Image
		created  bool
	}{
		// The spec mounts /app/uploads (a volume) and /tmp (a tmpfs).
		{"declared volumes all mounted", true, image("/app/uploads", "/tmp/"), true},
		{"no declared volume", true, image(), true},
		{"a volume the spec does not mount", true, image("/var/lib/data"), false},
		{"one of two not mounted", true, image("/app/uploads", "/data"), false},
		// Only the exact target counts: neither a path that climbs out of a mount nor one under
		// it, which Docker would still give its own anonymous volume.
		{"a path that climbs out of a mount", true, image("/app/uploads/../escape"), false},
		{"a path under a mount", true, image("/app/uploads/child"), false},
		{"a mount's name as a prefix", true, image("/app/uploads-extra"), false},
		{"a relative path", true, image("app/uploads"), false},
		// Without a read-only root the image volumes are what Docker always did.
		{"writable root", false, image("/var/lib/data"), true},
	} {
		// A release task creates its container under the same rule (SPEC 3.4).
		run := map[string]func(*fakeEngine, *agentv1.ContainerSpec) *agentv1.ActionUpdate{
			"container": func(engine *fakeEngine, spec *agentv1.ContainerSpec) *agentv1.ActionUpdate {
				return create(t, engine, spec)
			},
			"release task": func(engine *fakeEngine, spec *agentv1.ContainerSpec) *agentv1.ActionUpdate {
				d := &Dispatcher{Journal: open(t), Handlers: dockerHandlers(engine, nil, &fakeProber{}, nil), Epoch: func() uint64 { return 3 }}
				out := &recorder{}
				d.Handle(context.Background(), &agentv1.ActionRequest{ActionId: testID, IdempotencyKey: "release", LeaseEpoch: 3, DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
					Action: &agentv1.ActionRequest_RunReleaseTask{RunReleaseTask: &agentv1.RunReleaseTask{Spec: spec}}}, out.send)
				return out.last(t)
			},
		}
		for kind, apply := range run {
			t.Run(test.name+"/"+kind, func(t *testing.T) {
				spec := validSpec()
				spec.ReadOnlyRootfs = test.readOnly
				engine := newFakeEngine()
				engine.images[spec.GetImageRef()] = test.image
				update := apply(engine, spec)
				if test.created != (update.GetState() == agentv1.OperationState_OPERATION_STATE_SUCCEEDED) || test.created != (len(engine.created) == 1) {
					t.Fatalf("created=%v: %v", test.created, update)
				}
				if !test.created && update.GetError() != "the image declares a volume the configuration does not mount" {
					t.Fatalf("error %q", update.GetError())
				}
			})
		}
	}
}

// The names of the secret variables travel as a label, for log redaction (ADR 0029); their values
// stay in the environment alone.
func TestCreateContainerLabelsTheSecretNamesOnly(t *testing.T) {
	spec := validSpec()
	spec.Secrets = append(spec.Secrets, &agentv1.SecretEnv{Name: "API_TOKEN", Version: 1, Value: []byte("sk_fake_value")})
	_, config, err := containerConfig(spec, Workloads{})
	if err != nil {
		t.Fatal(err)
	}
	if config.Labels[SecretEnvLabel] != "API_TOKEN,DATABASE_URL" {
		t.Fatalf("label %q", config.Labels[SecretEnvLabel])
	}
	for key, value := range config.Labels {
		if strings.Contains(value, "private-secret") || strings.Contains(value, "sk_fake") {
			t.Fatalf("label %s carries a secret value", key)
		}
	}
	// Without secrets the label is still set, empty: its absence means a container that predates
	// it, whose values are all redacted (#470).
	spec.Secrets = nil
	if _, config, _ := containerConfig(spec, Workloads{}); config.Labels[SecretEnvLabel] != "" {
		t.Fatalf("label %q", config.Labels[SecretEnvLabel])
	} else if _, set := config.Labels[SecretEnvLabel]; !set {
		t.Fatal("a container without secrets has no label")
	}
}
