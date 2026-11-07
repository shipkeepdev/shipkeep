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
