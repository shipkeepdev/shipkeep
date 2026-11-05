package actions

import (
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
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

func TestCreateContainerSendsOnlyConfinedSettings(t *testing.T) {
	engine := newFakeEngine()
	if update := create(t, engine, validSpec()); !succeeded(update) || update.GetResult().GetContainerId() != "csk-api-r42" {
		t.Fatalf("create failed: %v", update)
	}
	config := engine.created[0]
	host := config.HostConfig
	if host.NetworkMode != "sk-acme-prod" || !slices.Equal(host.SecurityOpt, []string{"no-new-privileges:true"}) ||
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
	if config.Labels[docker.ManagedLabel] != "true" || config.Labels[identityLabel] != "sk-api-r42" || len(config.Labels[specLabel]) != 64 {
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
	changed := validSpec()
	changed.Command = []string{"node", "other.js"}
	if succeeded(create(t, engine, changed)) || len(engine.created) != 1 {
		t.Fatal("different spec reused or replaced an existing container")
	}
	foreign := newFakeEngine()
	foreign.containers = append(foreign.containers, docker.Container{ID: "x", Name: "/sk-api-r42"})
	if succeeded(create(t, foreign, validSpec())) || len(foreign.created) != 0 {
		t.Fatal("adopted an unmanaged container")
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
		"stop timeout of 1h":  func(s *agentv1.ContainerSpec) { s.StopTimeout = durationpb.New(time.Hour) },
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
