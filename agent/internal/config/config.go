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

	"github.com/shipkeepdev/shipkeep/agent/internal/gateway"
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
	Build        Build        `yaml:"build"`
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
	// JoinTokenFile is a private 0600 file consumed only after durable enrollment.
	JoinTokenFile string `yaml:"join_token_file"`
	// Connect, optional, is where the TCP connection to the gateway goes instead of Address: a
	// loopback IP literal with a port, on the machine that hosts the control plane (ADR 0021). The
	// gateway certificate is still verified against Address's host and the CA fingerprint.
	Connect string `yaml:"connect"`
	// Route, optional, is the control plane's own route on the machine that hosts it (ADR 0021):
	// the agent keeps it in Caddy from its start, before and independently of enrollment, and no
	// action can change or remove it.
	Route LocalRoute `yaml:"route"`
}

// LocalRoute sends a host name to a loopback address through the node's Caddy.
type LocalRoute struct {
	// Host is the control plane's public name, the host of its API_PUBLIC_URL.
	Host string `yaml:"host"`
	// Upstream is the loopback address and port the control plane's HTTP port is published on.
	Upstream string `yaml:"upstream"`
	// Registry, optional, is the loopback address and port the installation's registry is
	// published on (ADR 0030): Host's /v2/ path goes there. DefaultRegistryUpstream when empty, so
	// that a configuration written before builds existed serves the registry too.
	Registry string `yaml:"registry"`
}

// DefaultRegistryUpstream is where compose.single-machine.yml publishes the registry.
const DefaultRegistryUpstream = "127.0.0.1:5000"

// RegistryUpstream is where Host's /v2/ path goes.
func (r LocalRoute) RegistryUpstream() string {
	if r.Registry != "" {
		return r.Registry
	}
	return DefaultRegistryUpstream
}

// routeHost is a DNS name of at least two labels, lowercase, without a wildcard.
var routeHost = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

// Node holds node-level identity overrides.
type Node struct {
	// Name overrides the hostname as the node name shown in the UI. Optional.
	Name string `yaml:"name"`
	// Reservation is the share of the machine kept for the control plane and the rest of the
	// system, on the machine that hosts the control plane (ADR 0021). The agent reports it with its
	// facts, and placement leaves it free. Zero elsewhere.
	Reservation Reservation `yaml:"reservation"`
	// Role is what the machine is for (ADR 0028), written by the installer: `server` (the default
	// when empty), `control-plane` (the single machine that also runs applications) or
	// `control-plane-only` (a machine that runs the control plane alone). The control plane never
	// sets it.
	Role string `yaml:"role"`
}

// Roles of a machine (ADR 0028).
const (
	RoleServer           = "server"
	RoleControlPlane     = "control-plane"
	RoleControlPlaneOnly = "control-plane-only"
)

// Reservation is an amount of CPU and memory that applications may not use (ADR 0021).
type Reservation struct {
	CPUMillis   uint32 `yaml:"cpu_millis"`
	MemoryBytes uint64 `yaml:"memory_bytes"`
}

// Limits of a reservation: far above any machine, they only refuse values that are not amounts.
const (
	maxReservedCPUMillis   = 1_000_000
	maxReservedMemoryBytes = 1 << 50
)

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
	// WorkloadsSlice, optional, is the systemd slice every application container runs in
	// (CgroupParent), such as shipkeep-workloads.slice on the machine that hosts the control plane
	// (ADR 0021). The installer creates it with a memory limit.
	WorkloadsSlice string `yaml:"workloads_slice"`
	// WorkloadsOOMScoreAdj, optional, is the oom_score_adj of every application container, from 0
	// to 1000: 1000 makes the kernel kill an application before the control plane (ADR 0021).
	WorkloadsOOMScoreAdj *int `yaml:"workloads_oom_score_adj"`
}

// sliceName is a systemd slice name the agent may give Docker as CgroupParent: lowercase letters,
// digits and dashes, ending in .slice. A dash makes a child slice, so no leading or doubled dash.
var sliceName = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+){0,7}\.slice$`)

// Caddy configures the edge proxy admin endpoint (ADR 0005).
type Caddy struct {
	// AdminSocket is the Unix socket of Caddy's admin API. Caddy's TCP admin endpoint is disabled.
	AdminSocket string `yaml:"admin_socket"`
}

// Build configures the server's builder (ADR 0030).
type Build struct {
	// Socket is the Unix socket of the rootless BuildKit daemon the installer runs as
	// shipkeep-build. A server without it answers each build that its builder does not answer.
	Socket string `yaml:"socket"`
	// WorkDir holds the repository and the plan of a Railpack build for that build's time. The
	// installer makes it on the builds' own filesystem (#548), so that a build fills that one and
	// never the server's disk; the agent empties it and never makes it there.
	WorkDir string `yaml:"work_dir"`
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
		Build:  Build{Socket: "/run/shipkeep-build/buildkitd.sock", WorkDir: "/var/lib/shipkeep-build/exports"},
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
	cfg.Build.Socket = filepath.Join(baseDir, "run", "buildkitd.sock")
	cfg.Build.WorkDir = filepath.Join(baseDir, "builds")
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
	// A pointer in base would be shared with cfg: decoding would write into the caller's value.
	if adj := base.Docker.WorkloadsOOMScoreAdj; adj != nil {
		value := *adj
		cfg.Docker.WorkloadsOOMScoreAdj = &value
	}
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

	if route := c.ControlPlane.Route; route != (LocalRoute{}) {
		if len(route.Host) > 253 || !routeHost.MatchString(route.Host) {
			add("control_plane.route.host must be a lowercase DNS name such as shipkeep.example.com")
		}
		if !gateway.LoopbackConnect(route.Upstream) {
			add("control_plane.route.upstream must be a loopback address with a port, such as 127.0.0.1:8080")
		}
		if route.Registry != "" && !gateway.LoopbackConnect(route.Registry) {
			add("control_plane.route.registry must be a loopback address with a port, such as 127.0.0.1:5000")
		}
	}

	if c.ControlPlane.Connect != "" && !gateway.LoopbackConnect(c.ControlPlane.Connect) {
		add("control_plane.connect must be a loopback address with a port, such as 127.0.0.1:7443 or [::1]:7443")
	}

	switch {
	case c.ControlPlane.CAFingerprint == "" && !c.Dev:
		add("control_plane.ca_fingerprint is required (use the value shown in the install command)")
	case c.ControlPlane.CAFingerprint != "" && !fingerprintRe.MatchString(c.ControlPlane.CAFingerprint):
		add("control_plane.ca_fingerprint must look like sha256:<64 lowercase hex characters>")
	}

	if c.ControlPlane.JoinTokenFile != "" {
		if err := validatePath(c.ControlPlane.JoinTokenFile); err != nil {
			add("control_plane.join_token_file: %v", err)
		}
	}

	if c.Node.Name != "" && !validNodeName(c.Node.Name) {
		add("node.name must match ^[a-z][a-z0-9-]{1,38}[a-z0-9]$")
	}
	if c.Node.Reservation.CPUMillis > maxReservedCPUMillis {
		add("node.reservation.cpu_millis must be at most %d", maxReservedCPUMillis)
	}
	if c.Node.Reservation.MemoryBytes > maxReservedMemoryBytes {
		add("node.reservation.memory_bytes must be at most %d", uint64(maxReservedMemoryBytes))
	}
	switch c.Node.Role {
	case "", RoleServer, RoleControlPlane:
	case RoleControlPlaneOnly:
		// The whole machine is the control plane's: no application, so no share of it to keep, no
		// slice for workloads, and the control plane's own Caddy serves its route.
		if c.Node.Reservation != (Reservation{}) {
			add("node.reservation must be empty with node.role control-plane-only")
		}
		if c.Docker.WorkloadsSlice != "" {
			add("docker.workloads_slice must be empty with node.role control-plane-only")
		}
		if c.ControlPlane.Route != (LocalRoute{}) {
			add("control_plane.route must be empty with node.role control-plane-only")
		}
	default:
		add("node.role must be server, control-plane or control-plane-only")
	}
	if c.Docker.WorkloadsSlice != "" && (len(c.Docker.WorkloadsSlice) > 128 || !sliceName.MatchString(c.Docker.WorkloadsSlice) || c.Docker.WorkloadsSlice == "system.slice") {
		add("docker.workloads_slice must be a systemd slice name such as shipkeep-workloads.slice")
	}
	if adj := c.Docker.WorkloadsOOMScoreAdj; adj != nil && (*adj < 0 || *adj > 1000) {
		add("docker.workloads_oom_score_adj must be between 0 and 1000")
	}

	for name, p := range map[string]string{
		"paths.state_dir":    c.Paths.StateDir,
		"paths.run_dir":      c.Paths.RunDir,
		"caddy.admin_socket": c.Caddy.AdminSocket,
		"build.socket":       c.Build.Socket,
		"build.work_dir":     c.Build.WorkDir,
	} {
		if err := validatePath(p); err != nil {
			add("%s: %v", name, err)
		}
	}
	// Each build empties its work directory: never the agent's own state, or what holds it.
	for _, owned := range []struct{ name, path string }{
		{"paths.state_dir", c.Paths.StateDir},
		{"paths.run_dir", c.Paths.RunDir},
	} {
		if within(owned.path, c.Build.WorkDir) {
			add("build.work_dir must not be %s or a directory that holds it", owned.name)
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

// within reports whether path is dir itself or lies under it; `/` holds every path.
func within(path, dir string) bool {
	switch dir {
	case "":
		return false
	case "/":
		return true
	}
	return path == dir || strings.HasPrefix(path, dir+"/")
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
