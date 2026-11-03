// Package config loads and validates the agent configuration file (/etc/shipkeep/agent.yaml).
//
// The file is YAML with unknown keys rejected. Every value has a safe default except the control
// plane address and the installation CA fingerprint, which the installer writes at enrollment.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// DefaultPath is where the installer writes the configuration.
const DefaultPath = "/etc/shipkeep/agent.yaml"

// MaxFileBytes bounds the configuration file size.
const MaxFileBytes = 1 << 20

// Config is the agent configuration.
type Config struct {
	ControlPlane ControlPlane `yaml:"control_plane"`
	Node         Node         `yaml:"node"`
	Paths        Paths        `yaml:"paths"`
	Docker       Docker       `yaml:"docker"`
	Caddy        Caddy        `yaml:"caddy"`
	Log          Log          `yaml:"log"`
	Intervals    Intervals    `yaml:"intervals"`

	// Dev is set by the --dev flag, never from the file. It relaxes the fingerprint requirement
	// and switches logging to a human-readable format.
	Dev bool `yaml:"-"`
}

// ControlPlane describes how to reach the agent gateway.
type ControlPlane struct {
	// Address is host:port of the AgentGatewayService (SPEC 3.1, default port 7443).
	Address string `yaml:"address"`
	// CAFingerprint is "sha256:<64 hex>" of the installation CA, shown in the install command.
	// The agent refuses to send its join token to a gateway whose CA does not match (SPEC 3.2).
	CAFingerprint string `yaml:"ca_fingerprint"`
}

// Node holds node-level identity overrides.
type Node struct {
	// Name overrides the hostname as the node name shown in the UI. Optional.
	Name string `yaml:"name"`
}

// Paths are the directories the agent owns.
type Paths struct {
	// StateDir holds the SQLite state, the operation journal and the certificates. Mode 0700.
	StateDir string `yaml:"state_dir"`
	// RunDir holds runtime sockets.
	RunDir string `yaml:"run_dir"`
}

// Docker configures the Docker Engine API endpoint.
type Docker struct {
	// Host is a Docker daemon URL, unix:///var/run/docker.sock by default. TCP without TLS is refused.
	Host string `yaml:"host"`
}

// Caddy configures the edge proxy admin endpoint (ADR 0005).
type Caddy struct {
	// AdminSocket is the Unix socket of Caddy's admin API. Caddy's TCP admin endpoint is disabled.
	AdminSocket string `yaml:"admin_socket"`
}

// Log configures structured logging.
type Log struct {
	// Level is one of debug, info, warn, error.
	Level string `yaml:"level"`
	// Format is json (default) or text.
	Format string `yaml:"format"`
}

// Intervals are the periodic loops of the agent (ADR 0008, SPEC 3.5).
type Intervals struct {
	Heartbeat time.Duration `yaml:"heartbeat"`
	Reconcile time.Duration `yaml:"reconcile"`
}

// Default returns the configuration with every default applied and no control plane set.
func Default() Config {
	return Config{
		ControlPlane: ControlPlane{},
		Paths: Paths{
			StateDir: "/var/lib/shipkeep",
			RunDir:   "/run/shipkeep",
		},
		Docker: Docker{Host: "unix:///var/run/docker.sock"},
		Caddy:  Caddy{AdminSocket: "/run/shipkeep/caddy-admin.sock"},
		Log:    Log{Level: "info", Format: "json"},
		Intervals: Intervals{
			Heartbeat: 5 * time.Second,
			Reconcile: 30 * time.Second,
		},
	}
}

// DevDefault returns the configuration used by `shipkeep-agent --dev`: everything under a local
// directory, text logs at debug level, control plane on localhost.
func DevDefault(baseDir string) Config {
	cfg := Default()
	cfg.Dev = true
	cfg.ControlPlane.Address = "localhost:7443"
	cfg.Paths.StateDir = filepath.Join(baseDir, "state")
	cfg.Paths.RunDir = filepath.Join(baseDir, "run")
	cfg.Caddy.AdminSocket = filepath.Join(baseDir, "run", "caddy-admin.sock")
	cfg.Log.Level = "debug"
	cfg.Log.Format = "text"
	return cfg
}

// Load reads path and overlays it on base. A missing file is an error unless optional is true.
func Load(path string, base Config, optional bool) (Config, error) {
	data, err := os.ReadFile(path) //nolint:gosec // the path comes from the operator's flag, not from the network
	if err != nil {
		if optional && errors.Is(err, os.ErrNotExist) {
			return base, nil
		}
		return Config{}, fmt.Errorf("read config %s: %w", path, err)
	}
	cfg, err := Parse(data, base)
	if err != nil {
		return Config{}, fmt.Errorf("config %s: %w", path, err)
	}
	return cfg, nil
}

// Parse decodes YAML on top of base. Unknown keys are errors.
func Parse(data []byte, base Config) (Config, error) {
	if len(data) > MaxFileBytes {
		return Config{}, fmt.Errorf("file exceeds %d bytes", MaxFileBytes)
	}
	cfg := base
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil && !errors.Is(err, errEOF(err)) {
		return Config{}, fmt.Errorf("parse YAML: %w", err)
	}
	cfg.Dev = base.Dev
	return cfg, nil
}

// errEOF returns err itself when it is the decoder's end-of-stream (empty file), which is not
// an error for us, or nil otherwise.
func errEOF(err error) error {
	if err != nil && err.Error() == "EOF" {
		return err
	}
	return nil
}

var fingerprintRe = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Validate checks every field. It returns all problems at once so the operator can fix them in
// one pass.
func (c Config) Validate() error {
	var problems []string
	add := func(format string, args ...any) {
		problems = append(problems, fmt.Sprintf(format, args...))
	}

	if c.ControlPlane.Address == "" {
		add("control_plane.address is required")
	} else if err := validateHostPort(c.ControlPlane.Address); err != nil {
		add("control_plane.address: %v", err)
	}

	switch {
	case c.ControlPlane.CAFingerprint == "" && !c.Dev:
		add("control_plane.ca_fingerprint is required (use the value shown in the install command)")
	case c.ControlPlane.CAFingerprint != "" && !fingerprintRe.MatchString(c.ControlPlane.CAFingerprint):
		add("control_plane.ca_fingerprint must look like sha256:<64 lowercase hex characters>")
	}

	if c.Node.Name != "" && !validNodeName(c.Node.Name) {
		add("node.name must match ^[a-z][a-z0-9-]{1,38}[a-z0-9]$")
	}

	for name, p := range map[string]string{
		"paths.state_dir":    c.Paths.StateDir,
		"paths.run_dir":      c.Paths.RunDir,
		"caddy.admin_socket": c.Caddy.AdminSocket,
	} {
		if err := validatePath(p); err != nil {
			add("%s: %v", name, err)
		}
	}

	if err := validateDockerHost(c.Docker.Host); err != nil {
		add("docker.host: %v", err)
	}

	switch c.Log.Level {
	case "debug", "info", "warn", "error":
	default:
		add("log.level must be one of debug, info, warn, error")
	}
	switch c.Log.Format {
	case "json", "text":
	default:
		add("log.format must be json or text")
	}

	if c.Intervals.Heartbeat < time.Second || c.Intervals.Heartbeat > time.Minute {
		add("intervals.heartbeat must be between 1s and 1m")
	}
	if c.Intervals.Reconcile < 5*time.Second || c.Intervals.Reconcile > time.Hour {
		add("intervals.reconcile must be between 5s and 1h")
	}

	if len(problems) == 0 {
		return nil
	}
	return &ValidationError{Problems: problems}
}

// ValidationError lists every problem found in a configuration.
type ValidationError struct {
	Problems []string
}

func (e *ValidationError) Error() string {
	return "invalid agent configuration: " + strings.Join(e.Problems, "; ")
}

func validateHostPort(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return errors.New("must be host:port")
	}
	if host == "" {
		return errors.New("host is empty")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return errors.New("port must be between 1 and 65535")
	}
	return nil
}

var nodeNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,38}[a-z0-9]$`)

func validNodeName(name string) bool {
	return nodeNameRe.MatchString(name)
}

func validatePath(p string) error {
	if p == "" {
		return errors.New("is required")
	}
	if !filepath.IsAbs(p) {
		return errors.New("must be an absolute path")
	}
	if filepath.Clean(p) != p {
		return errors.New("must be a clean path (no '..', '.' or trailing slash)")
	}
	return nil
}

func validateDockerHost(host string) error {
	switch {
	case host == "":
		return errors.New("is required")
	case strings.HasPrefix(host, "unix://"):
		return validatePath(strings.TrimPrefix(host, "unix://"))
	case strings.HasPrefix(host, "tcp://"):
		// TCP without TLS exposes a root-equivalent API; the agent only ever talks to the local socket.
		return errors.New("tcp:// endpoints are not supported, use a unix:// socket")
	default:
		return errors.New("must start with unix://")
	}
}
