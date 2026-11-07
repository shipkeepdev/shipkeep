package actions

import (
	"fmt"
	"net/netip"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Limits of a container specification (SPEC 3.3). Every bound is checked before the daemon.
const (
	maxCommand      = 64
	maxArgument     = 4096
	maxEnv          = 256
	maxEnvValue     = 32 * 1024
	maxSecretValue  = 64 * 1024
	maxMounts       = 16
	maxPorts        = 32
	maxDNS          = 3
	maxCPUMillis    = 256_000
	maxMemoryBytes  = 1 << 40
	maxTmpfsBytes   = 1 << 30
	maxStopSeconds  = 600
	defaultPids     = 1024
	maxPids         = 65_536
	maxRestarts     = 100
	identityLabel   = "sk.name"
	maxWorkingDir   = 1024
	maxContainerDir = 1024
)

var (
	envName  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	userSpec = regexp.MustCompile(`^(?:[0-9]{1,10}|[a-z_][a-z0-9_-]{0,31})(?::(?:[0-9]{1,10}|[a-z_][a-z0-9_-]{0,31}))?$`)
	// forbiddenRoots may never be mount targets (SPEC 2.2).
	forbiddenRoots = []string{"/proc", "/sys", "/dev", "/etc", "/var/run", "/run"}
	capabilities   = map[agentv1.Capability]string{
		agentv1.Capability_CAPABILITY_NET_BIND_SERVICE: "NET_BIND_SERVICE",
		agentv1.Capability_CAPABILITY_CHOWN:            "CHOWN",
		agentv1.Capability_CAPABILITY_SETUID:           "SETUID",
		agentv1.Capability_CAPABILITY_SETGID:           "SETGID",
	}
)

// containerConfig validates spec completely and returns the only create body the agent sends.
// Privileged mode, host namespaces, devices and bind mounts cannot be expressed at all.
func containerConfig(spec *agentv1.ContainerSpec) (string, docker.ContainerConfig, error) {
	if spec == nil || !resourceName.MatchString(spec.GetName()) || !imageRef.MatchString(spec.GetImageRef()) ||
		len(spec.GetImageRef()) > maxImageRef || !resourceName.MatchString(spec.GetNetwork()) {
		return "", docker.ContainerConfig{}, errInput
	}
	if spec.GetSecretsAsFiles() {
		// File-mounted secrets need a tmpfs writer that does not exist yet: refuse rather than
		// silently falling back to environment variables.
		return "", docker.ContainerConfig{}, errInput
	}
	command, err := argv(spec.GetCommand())
	if err != nil {
		return "", docker.ContainerConfig{}, err
	}
	env, err := environment(spec)
	if err != nil {
		return "", docker.ContainerConfig{}, err
	}
	labels, err := volumeLabels(spec.GetLabels())
	if err != nil {
		return "", docker.ContainerConfig{}, err
	}
	labels[identityLabel] = spec.GetName()
	mounts, err := containerMounts(spec.GetMounts())
	if err != nil {
		return "", docker.ContainerConfig{}, err
	}
	ports, err := exposedPorts(spec.GetPorts())
	if err != nil {
		return "", docker.ContainerConfig{}, err
	}
	host := docker.HostConfig{
		NetworkMode: spec.GetNetwork(),
		Mounts:      mounts,
		// no-new-privileges blocks setuid escalation even when SETUID is added.
		SecurityOpt:    []string{"no-new-privileges:true"},
		ReadonlyRootfs: spec.GetReadOnlyRootfs(),
		PidsLimit:      defaultPids,
		IpcMode:        "private",
		Init:           true,
		LogConfig:      map[string]any{"Type": "json-file", "Config": map[string]string{"max-size": "10m", "max-file": "3"}},
	}
	if err := resources(spec.GetResources(), &host); err != nil {
		return "", docker.ContainerConfig{}, err
	}
	if host.DNS, err = dnsServers(spec.GetDnsServers()); err != nil {
		return "", docker.ContainerConfig{}, err
	}
	if host.CapAdd, err = capAdd(spec.GetCapAdd()); err != nil {
		return "", docker.ContainerConfig{}, err
	}
	if host.RestartPolicy, err = restartPolicy(spec.GetRestartPolicy()); err != nil {
		return "", docker.ContainerConfig{}, err
	}
	config := docker.ContainerConfig{Image: spec.GetImageRef(), Cmd: command, Env: env, Labels: labels, ExposedPorts: ports, HostConfig: host}
	if dir := spec.GetWorkingDir(); dir != "" {
		if !cleanAbsolute(dir, maxWorkingDir) {
			return "", docker.ContainerConfig{}, errInput
		}
		config.WorkingDir = dir
	}
	if user := spec.GetUser(); user != "" {
		if !userSpec.MatchString(user) {
			return "", docker.ContainerConfig{}, errInput
		}
		config.User = user
	}
	if timeout := spec.GetStopTimeout(); timeout != nil {
		seconds := timeout.AsDuration().Seconds()
		if timeout.CheckValid() != nil || seconds < 0 || seconds > maxStopSeconds {
			return "", docker.ContainerConfig{}, errInput
		}
		value := int(seconds)
		config.StopTimeout = &value
	}
	return spec.GetName(), config, nil
}

func argv(command []string) ([]string, error) {
	if len(command) > maxCommand {
		return nil, errInput
	}
	for _, argument := range command {
		if len(argument) > maxArgument || strings.ContainsRune(argument, 0) {
			return nil, errInput
		}
	}
	return slices.Clone(command), nil
}

func environment(spec *agentv1.ContainerSpec) ([]string, error) {
	if len(spec.GetEnv())+len(spec.GetSecrets()) > maxEnv {
		return nil, errInput
	}
	seen := map[string]bool{}
	env := make([]string, 0, len(spec.GetEnv())+len(spec.GetSecrets()))
	add := func(name, value string, limit int) error {
		if !envName.MatchString(name) || seen[name] || len(value) > limit || strings.ContainsRune(value, 0) {
			return errInput
		}
		seen[name] = true
		env = append(env, name+"="+value)
		return nil
	}
	for _, variable := range spec.GetEnv() {
		if err := add(variable.GetName(), variable.GetValue(), maxEnvValue); err != nil {
			return nil, err
		}
	}
	for _, secret := range spec.GetSecrets() {
		if err := add(secret.GetName(), string(secret.GetValue()), maxSecretValue); err != nil {
			return nil, err
		}
	}
	return env, nil
}

func containerMounts(input []*agentv1.Mount) ([]docker.Mount, error) {
	if len(input) > maxMounts {
		return nil, errInput
	}
	targets := map[string]bool{}
	mounts := make([]docker.Mount, 0, len(input))
	for _, mount := range input {
		target := mount.GetContainerPath()
		if !cleanAbsolute(target, maxContainerDir) || target == "/" || targets[target] || underForbidden(target) {
			return nil, errInput
		}
		targets[target] = true
		switch source := mount.GetSource().(type) {
		case *agentv1.Mount_VolumeName:
			if !resourceName.MatchString(source.VolumeName) {
				return nil, errInput
			}
			mounts = append(mounts, docker.Mount{Type: "volume", Source: source.VolumeName, Target: target, ReadOnly: mount.GetReadOnly()})
		case *agentv1.Mount_Tmpfs_:
			size, mode := source.Tmpfs.GetSizeBytes(), source.Tmpfs.GetMode()
			if size == 0 || size > maxTmpfsBytes || mode > 0o7777 {
				return nil, errInput
			}
			mounts = append(mounts, docker.Mount{Type: "tmpfs", Target: target, ReadOnly: mount.GetReadOnly(),
				TmpfsOptions: &docker.TmpfsOptions{SizeBytes: int64(size), Mode: int(mode)}})
		default:
			return nil, errInput
		}
	}
	return mounts, nil
}

// exposedPorts declares container ports on the Docker network. Nothing is published on the host:
// Caddy reaches containers over their network (SPEC 3.3).
func exposedPorts(input []*agentv1.PortMapping) (map[string]struct{}, error) {
	if len(input) > maxPorts {
		return nil, errInput
	}
	ports := map[string]struct{}{}
	for _, port := range input {
		number := port.GetContainerPort()
		if number == 0 || number > 65535 || (port.GetHostPort() != 0 && port.GetHostPort() != number) {
			return nil, errInput
		}
		protocol := "tcp"
		switch port.GetProtocol() {
		case agentv1.PortMapping_PROTOCOL_UNSPECIFIED, agentv1.PortMapping_PROTOCOL_TCP:
		case agentv1.PortMapping_PROTOCOL_UDP:
			protocol = "udp"
		default:
			return nil, errInput
		}
		ports[fmt.Sprintf("%d/%s", number, protocol)] = struct{}{}
	}
	return ports, nil
}

func resources(input *agentv1.Resources, host *docker.HostConfig) error {
	if input == nil {
		return nil
	}
	if input.GetCpuMillis() > maxCPUMillis || input.GetMemoryBytes() > maxMemoryBytes || input.GetPidsLimit() > maxPids {
		return errInput
	}
	host.NanoCPUs = int64(input.GetCpuMillis()) * 1_000_000
	host.Memory = int64(input.GetMemoryBytes()) //nolint:gosec // bounded above
	if input.GetPidsLimit() > 0 {
		host.PidsLimit = int64(input.GetPidsLimit())
	}
	return nil
}

func dnsServers(input []string) ([]string, error) {
	if len(input) > maxDNS {
		return nil, errInput
	}
	for _, server := range input {
		address, err := netip.ParseAddr(server)
		if err != nil || address.String() != server || address.IsUnspecified() || address.IsMulticast() {
			return nil, errInput
		}
	}
	return slices.Clone(input), nil
}

func capAdd(input []agentv1.Capability) ([]string, error) {
	added := make([]string, 0, len(input))
	for _, capability := range input {
		name, ok := capabilities[capability]
		if !ok || slices.Contains(added, name) {
			return nil, errInput
		}
		added = append(added, name)
	}
	return added, nil
}

func restartPolicy(input *agentv1.RestartPolicy) (docker.RestartPolicy, error) {
	switch input.GetMode() {
	case agentv1.RestartPolicy_MODE_UNSPECIFIED, agentv1.RestartPolicy_MODE_ALWAYS:
		return docker.RestartPolicy{Name: "unless-stopped"}, nil
	case agentv1.RestartPolicy_MODE_NEVER:
		return docker.RestartPolicy{Name: "no"}, nil
	case agentv1.RestartPolicy_MODE_ON_FAILURE:
		if input.GetMaxRestarts() > maxRestarts {
			return docker.RestartPolicy{}, errInput
		}
		return docker.RestartPolicy{Name: "on-failure", MaximumRetryCount: int(input.GetMaxRestarts())}, nil
	default:
		return docker.RestartPolicy{}, errInput
	}
}

// cleanAbsolute accepts an absolute, already-clean path without `..`, NUL or control bytes.
func cleanAbsolute(value string, limit int) bool {
	return len(value) <= limit && strings.HasPrefix(value, "/") && path.Clean(value) == value &&
		!strings.Contains(value, "..") && printable(value, limit)
}

func underForbidden(target string) bool {
	for _, root := range forbiddenRoots {
		if target == root || strings.HasPrefix(target, root+"/") {
			return true
		}
	}
	return false
}
