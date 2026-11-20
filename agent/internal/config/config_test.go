package config_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/config"
)

const fingerprint = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func validYAML() string {
	return "control_plane:\n  address: cp.example.com:7443\n  ca_fingerprint: " + fingerprint + "\n"
}

func TestDefaultsAreValidOnceControlPlaneIsSet(t *testing.T) {
	t.Parallel()
	cfg, err := config.Parse([]byte(validYAML()), config.Default())
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if cfg.Paths.StateDir != "/var/lib/shipkeep" || cfg.Log.Format != "json" || cfg.Intervals.Heartbeat != 5*time.Second {
		t.Fatalf("defaults not applied: %+v", cfg)
	}
}

func TestDevDefaultIsValidWithoutFingerprint(t *testing.T) {
	t.Parallel()
	cfg := config.DevDefault("/tmp/shipkeep-dev")
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if !cfg.Dev || cfg.Log.Format != "text" || !strings.HasPrefix(cfg.Paths.StateDir, "/tmp/shipkeep-dev") {
		t.Fatalf("dev defaults wrong: %+v", cfg)
	}
}

func TestDevFlagCannotComeFromTheFile(t *testing.T) {
	t.Parallel()
	_, err := config.Parse([]byte(validYAML()+"dev: true\n"), config.Default())
	if err == nil {
		t.Fatal("dev key in file must be rejected as unknown")
	}
}

func TestParseRejectsUnknownKeys(t *testing.T) {
	t.Parallel()
	_, err := config.Parse([]byte(validYAML()+"shell: /bin/sh\n"), config.Default())
	if err == nil || !strings.Contains(err.Error(), "shell") {
		t.Fatalf("Parse() error = %v, want unknown field error", err)
	}
}

func TestParseRejectsOversizedAndBrokenFiles(t *testing.T) {
	t.Parallel()
	if _, err := config.Parse([]byte(strings.Repeat("#", config.MaxFileBytes+1)), config.Default()); err == nil {
		t.Fatal("oversized file accepted")
	}
	if _, err := config.Parse([]byte("control_plane: [unclosed"), config.Default()); err == nil {
		t.Fatal("broken YAML accepted")
	}
}

func TestParseAcceptsEmptyFile(t *testing.T) {
	t.Parallel()
	cfg, err := config.Parse(nil, config.DevDefault("/tmp/x"))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if cfg.ControlPlane.Address != "localhost:7443" {
		t.Fatalf("base not preserved: %+v", cfg)
	}
}

func TestValidateReportsEveryProblem(t *testing.T) {
	t.Parallel()
	tests := map[string]struct {
		yaml string
		want []string
	}{
		"missing address":       {"control_plane:\n  ca_fingerprint: " + fingerprint + "\n", []string{"control_plane.address is required"}},
		"address without port":  {"control_plane:\n  address: cp.example.com\n  ca_fingerprint: " + fingerprint + "\n", []string{"host:port"}},
		"address bad port":      {"control_plane:\n  address: cp.example.com:99999\n  ca_fingerprint: " + fingerprint + "\n", []string{"port must be"}},
		"missing fingerprint":   {"control_plane:\n  address: cp.example.com:7443\n", []string{"ca_fingerprint is required"}},
		"malformed fingerprint": {"control_plane:\n  address: cp.example.com:7443\n  ca_fingerprint: sha256:ZZ\n", []string{"ca_fingerprint must look like"}},
		"uppercase fingerprint": {"control_plane:\n  address: cp.example.com:7443\n  ca_fingerprint: " + strings.ToUpper(fingerprint) + "\n", []string{"ca_fingerprint must look like"}},
		"connect not loopback":  {validYAML() + "  connect: 10.0.0.5:7443\n", []string{"control_plane.connect must be a loopback address"}},
		"connect by name":       {validYAML() + "  connect: localhost:7443\n", []string{"control_plane.connect must be a loopback address"}},
		"connect without port":  {validYAML() + "  connect: 127.0.0.1\n", []string{"control_plane.connect must be a loopback address"}},
		"connect injection":     {validYAML() + "  connect: \"127.0.0.1:7443;id\"\n", []string{"control_plane.connect must be a loopback address"}},
		"bad node name":         {validYAML() + "node:\n  name: Node_1\n", []string{"node.name"}},
		"relative state dir":    {validYAML() + "paths:\n  state_dir: var/lib/shipkeep\n", []string{"paths.state_dir: must be an absolute path"}},
		"traversal state dir":   {validYAML() + "paths:\n  state_dir: /var/lib/../etc\n", []string{"paths.state_dir: must be a clean path"}},
		"empty run dir":         {validYAML() + "paths:\n  run_dir: \"\"\n", []string{"paths.run_dir: is required"}},
		"tcp docker host":       {validYAML() + "docker:\n  host: tcp://10.0.0.5:2375\n", []string{"docker.host: tcp://"}},
		"junk docker host":      {validYAML() + "docker:\n  host: /var/run/docker.sock\n", []string{"docker.host: must start with unix://"}},
		"relative caddy socket": {validYAML() + "caddy:\n  admin_socket: caddy.sock\n", []string{"caddy.admin_socket"}},
		"bad log level":         {validYAML() + "log:\n  level: verbose\n", []string{"log.level"}},
		"bad log format":        {validYAML() + "log:\n  format: xml\n", []string{"log.format"}},
		"heartbeat too short":   {validYAML() + "intervals:\n  heartbeat: 100ms\n", []string{"intervals.heartbeat"}},
		"reconcile too long":    {validYAML() + "intervals:\n  reconcile: 2h\n", []string{"intervals.reconcile"}},
		"many problems at once": {"control_plane:\n  address: nope\nlog:\n  level: loud\n  format: xml\n", []string{"control_plane.address", "ca_fingerprint", "log.level", "log.format"}},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			cfg, err := config.Parse([]byte(tt.yaml), config.Default())
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			err = cfg.Validate()
			var verr *config.ValidationError
			if !errors.As(err, &verr) {
				t.Fatalf("Validate() error = %v, want *ValidationError", err)
			}
			for _, want := range tt.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not mention %q", err.Error(), want)
				}
			}
		})
	}
}

func TestLoadFromFile(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(path, []byte(validYAML()+"node:\n  name: edge-1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(path, config.Default(), false)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Node.Name != "edge-1" {
		t.Fatalf("Node.Name = %q", cfg.Node.Name)
	}

	if _, err := config.Load(filepath.Join(dir, "missing.yaml"), config.Default(), false); err == nil {
		t.Fatal("missing required file accepted")
	}
	cfg, err = config.Load(filepath.Join(dir, "missing.yaml"), config.DevDefault(dir), true)
	if err != nil || !cfg.Dev {
		t.Fatalf("optional missing file: cfg=%+v err=%v", cfg, err)
	}
}

func TestConnectOnLoopbackIsValid(t *testing.T) {
	t.Parallel()
	for _, connect := range []string{"127.0.0.1:7443", "\"[::1]:7443\""} {
		cfg, err := config.Parse([]byte(validYAML()+"  connect: "+connect+"\n"), config.Default())
		if err != nil {
			t.Fatal(err)
		}
		if err := cfg.Validate(); err != nil {
			t.Fatalf("%s: %v", connect, err)
		}
		if cfg.ControlPlane.Connect == "" {
			t.Fatalf("%s: not read", connect)
		}
	}
}

// The single-machine settings of ADR 0021, as the installer writes them.
func TestSingleMachineSettingsAreValid(t *testing.T) {
	t.Parallel()
	yaml := validYAML() + "node:\n  reservation:\n    cpu_millis: 500\n    memory_bytes: 1073741824\n" +
		"docker:\n  workloads_slice: shipkeep-workloads.slice\n  workloads_oom_score_adj: 1000\n"
	cfg, err := config.Parse([]byte(yaml), config.Default())
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if cfg.Node.Reservation.CPUMillis != 500 || cfg.Node.Reservation.MemoryBytes != 1<<30 ||
		cfg.Docker.WorkloadsSlice != "shipkeep-workloads.slice" || cfg.Docker.WorkloadsOOMScoreAdj == nil || *cfg.Docker.WorkloadsOOMScoreAdj != 1000 {
		t.Fatalf("not read: %+v %+v", cfg.Node, cfg.Docker)
	}
	plain, err := config.Parse([]byte(validYAML()), config.Default())
	if err != nil {
		t.Fatal(err)
	}
	if plain.Docker.WorkloadsSlice != "" || plain.Docker.WorkloadsOOMScoreAdj != nil || plain.Node.Reservation != (config.Reservation{}) {
		t.Fatal("an ordinary node must default to no slice, no kill-order change and no reservation")
	}
}

func TestSingleMachineSettingsRefuseMaliciousValues(t *testing.T) {
	t.Parallel()
	for name, block := range map[string]string{
		"traversal slice":      "docker:\n  workloads_slice: ../shipkeep.slice\n",
		"absolute slice":       "docker:\n  workloads_slice: /sys/fs/cgroup/x.slice\n",
		"root slice":           "docker:\n  workloads_slice: \"-.slice\"\n",
		"system slice":         "docker:\n  workloads_slice: system.slice\n",
		"doubled dash":         "docker:\n  workloads_slice: shipkeep--workloads.slice\n",
		"leading dash":         "docker:\n  workloads_slice: -workloads.slice\n",
		"scope":                "docker:\n  workloads_slice: shipkeep-workloads.scope\n",
		"space":                "docker:\n  workloads_slice: \"shipkeep workloads.slice\"\n",
		"newline":              "docker:\n  workloads_slice: \"shipkeep.slice\\nx\"\n",
		"uppercase":            "docker:\n  workloads_slice: Shipkeep.slice\n",
		"oversized":            "docker:\n  workloads_slice: " + strings.Repeat("a", 200) + ".slice\n",
		"negative adjustment":  "docker:\n  workloads_oom_score_adj: -1\n",
		"protected adjustment": "docker:\n  workloads_oom_score_adj: -1000\n",
		"adjustment too large": "docker:\n  workloads_oom_score_adj: 1001\n",
		"cpu reservation":      "node:\n  reservation:\n    cpu_millis: 1000001\n",
		"memory reservation":   "node:\n  reservation:\n    memory_bytes: 1125899906842625\n",
	} {
		cfg, err := config.Parse([]byte(validYAML()+block), config.Default())
		if err != nil {
			continue // refused while parsing (a negative unsigned amount, for example)
		}
		if err := cfg.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	for name, block := range map[string]string{
		"negative cpu":    "node:\n  reservation:\n    cpu_millis: -500\n",
		"text memory":     "node:\n  reservation:\n    memory_bytes: 1Gi\n",
		"text adjustment": "docker:\n  workloads_oom_score_adj: high\n",
	} {
		if _, err := config.Parse([]byte(validYAML()+block), config.Default()); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
}

// Decoding an overlay never writes into the base it starts from.
func TestParseLeavesTheBaseAdjustmentAlone(t *testing.T) {
	t.Parallel()
	adj := 1000
	base := config.Default()
	base.Docker.WorkloadsOOMScoreAdj = &adj
	cfg, err := config.Parse([]byte(validYAML()+"docker:\n  workloads_oom_score_adj: 0\n"), base)
	if err != nil {
		t.Fatal(err)
	}
	if *cfg.Docker.WorkloadsOOMScoreAdj != 0 || adj != 1000 {
		t.Fatalf("overlay %d, base %d", *cfg.Docker.WorkloadsOOMScoreAdj, adj)
	}
	if _, err := config.Parse([]byte(validYAML()+"docker:\n  workloads_oom_score_adj: 0\n  unknown: x\n"), base); err == nil {
		t.Fatal("unknown key accepted")
	}
	if adj != 1000 {
		t.Fatalf("a failed decode changed the base to %d", adj)
	}
}

// The control plane's route on the machine that hosts it (ADR 0021).
func TestControlPlaneRouteSettings(t *testing.T) {
	t.Parallel()
	valid := validYAML() + "  route:\n    host: shipkeep.example.com\n    upstream: 127.0.0.1:8080\n"
	cfg, err := config.Parse([]byte(valid), config.Default())
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	if cfg.ControlPlane.Route.Host != "shipkeep.example.com" || cfg.ControlPlane.Route.Upstream != "127.0.0.1:8080" {
		t.Fatalf("not read: %+v", cfg.ControlPlane.Route)
	}
	for name, route := range map[string]string{
		"public upstream":       "    host: shipkeep.example.com\n    upstream: 203.0.113.5:8080\n",
		"private upstream":      "    host: shipkeep.example.com\n    upstream: 10.0.0.2:8080\n",
		"name as upstream":      "    host: shipkeep.example.com\n    upstream: localhost:8080\n",
		"upstream without port": "    host: shipkeep.example.com\n    upstream: 127.0.0.1\n",
		"upstream port zero":    "    host: shipkeep.example.com\n    upstream: 127.0.0.1:0\n",
		"host only":             "    host: shipkeep.example.com\n",
		"upstream only":         "    upstream: 127.0.0.1:8080\n",
		"wildcard host":         "    host: \"*.example.com\"\n    upstream: 127.0.0.1:8080\n",
		"uppercase host":        "    host: Shipkeep.example.com\n    upstream: 127.0.0.1:8080\n",
		"single label":          "    host: shipkeep\n    upstream: 127.0.0.1:8080\n",
		"host with port":        "    host: shipkeep.example.com:443\n    upstream: 127.0.0.1:8080\n",
		"host with path":        "    host: shipkeep.example.com/admin\n    upstream: 127.0.0.1:8080\n",
		"ip host":               "    host: 203.0.113.5\n    upstream: 127.0.0.1:8080\n",
		"newline in host":       "    host: \"shipkeep.example.com\\nx\"\n    upstream: 127.0.0.1:8080\n",
		"oversized host":        "    host: " + strings.Repeat("a", 250) + ".example.com\n    upstream: 127.0.0.1:8080\n",
	} {
		cfg, err := config.Parse([]byte(validYAML()+"  route:\n"+route), config.Default())
		if err != nil {
			continue
		}
		if err := cfg.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
