package actions

// Fuzz targets for the agent action validators the threat model lists (THREAT_MODEL, security
// engineering requirements; #244): routes, health checks and container specs. Each states what an
// accepted input must satisfy, so a validator that lets something through fails, not only one that
// panics. The nightly workflow runs every target for five minutes.

import (
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

func FuzzRouteValidation(f *testing.F) {
	f.Add("api-prod", "api.acme.example.com", "*.preview.example.com", "172.18.0.5:8080", "", uint32(0), uint32(1), int32(1), false, int64(10_000))
	f.Add("api-prod", "api.acme.example.com", "", "", "sk-api-1", uint32(8080), uint32(0), int32(0), false, int64(0))
	f.Add("api-prod", "api.acme.example.com", "", "", "", uint32(0), uint32(0), int32(3), true, int64(-1))
	f.Add("../config", "a.example.com\"},{\"handler", "localhost", "127.0.0.1:2019", "sk-x", uint32(70000), uint32(1000), int32(2), true, int64(1<<62))
	f.Fuzz(func(t *testing.T, id, host1, host2, address, container string, port, weight uint32, tls int32, maintenance bool, drainMs int64) {
		route := &agentv1.Route{RouteId: id, TlsMode: agentv1.TlsMode(tls), Maintenance: maintenance}
		for _, host := range []string{host1, host2} {
			if host != "" {
				route.Hosts = append(route.Hosts, host)
			}
		}
		if address != "" || container != "" || port != 0 {
			route.Upstreams = []*agentv1.Upstream{{Address: address, Container: container, Port: port, Weight: weight}}
		}
		if drainMs >= 0 {
			route.DrainTimeout = durationpb.New(time.Duration(drainMs) * time.Millisecond)
		}
		template, local, plain, drain, err := caddyRoute(route)
		if err != nil {
			return
		}
		if template.ID != caddy.RouteID(id) || !strings.HasPrefix(template.ID, "sk-route-") || !routeID.MatchString(id) {
			t.Fatalf("accepted route id %q as %q", id, template.ID)
		}
		if drain < 0 || drain > maxDrain {
			t.Fatalf("accepted drain %v", drain)
		}
		if len(template.Match) != 1 || len(template.Handle) != 1 {
			t.Fatalf("unexpected route shape: %+v", template)
		}
		match := template.Match[0]
		if len(match.Host) == 0 || len(match.Host) > maxHosts || plain == (match.Protocol == caddy.HTTPS) {
			t.Fatalf("unexpected match: %+v (plain %v)", match, plain)
		}
		for _, host := range match.Host {
			if len(host) > maxHostnameBytes || !hostname.MatchString(host) {
				t.Fatalf("accepted host %q", host)
			}
		}
		handler := template.Handle[0]
		// Exactly one of the two: the agent's own page, or private upstreams (ADR 0017, ADR 0025).
		if maintenance {
			if handler.Handler != "static_response" || handler.Body != caddy.MaintenanceHandler().Body || len(handler.Upstreams) != 0 {
				t.Fatalf("maintenance route proxies or serves something else: %+v", handler)
			}
			return
		}
		if handler.Handler != "reverse_proxy" || len(handler.Upstreams) != 1 || handler.Body != "" {
			t.Fatalf("unexpected handler: %+v", handler)
		}
		if len(local) == 1 {
			if !resourceName.MatchString(local[0].name) || local[0].port == 0 || handler.Upstreams[0].Dial != "" {
				t.Fatalf("accepted container upstream %+v", local[0])
			}
			return
		}
		dial, err := netip.ParseAddrPort(handler.Upstreams[0].Dial)
		if err != nil || !dial.Addr().IsPrivate() || dial.Port() == 0 {
			t.Fatalf("accepted upstream %q", handler.Upstreams[0].Dial)
		}
	})
}

func FuzzHealthSpec(f *testing.F) {
	f.Add("/health", uint32(0), int64(5_000), int64(2_000), int64(0), int64(60_000), uint32(2), uint32(3))
	f.Add("", uint32(5432), int64(1_000), int64(100), int64(30_000), int64(1_000), uint32(1), uint32(1))
	f.Add("//evil", uint32(0), int64(-1), int64(0), int64(0), int64(0), uint32(11), uint32(0))
	f.Add("/a b#c\\", uint32(70_000), int64(1), int64(2), int64(3), int64(4), uint32(0), uint32(99))
	f.Fuzz(func(t *testing.T, path string, port uint32, intervalMs, timeoutMs, startMs, deadlineMs int64, healthy, unhealthy uint32) {
		spec := &agentv1.HealthCheckSpec{HealthyThreshold: healthy, UnhealthyThreshold: unhealthy}
		if path != "" {
			spec.Probe = &agentv1.HealthCheckSpec_HttpPath{HttpPath: path}
		} else {
			spec.Probe = &agentv1.HealthCheckSpec_TcpPort{TcpPort: port}
		}
		duration := func(ms int64) *durationpb.Duration { return durationpb.New(time.Duration(ms) * time.Millisecond) }
		spec.Interval, spec.Timeout, spec.StartPeriod = duration(intervalMs), duration(timeoutMs), duration(startMs)
		policy, err := parseHealth(spec, duration(deadlineMs))
		if err != nil {
			return
		}
		if path != "" && (!strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || len(path) > 2048 || strings.ContainsAny(path, " #\\\x00\r\n")) {
			t.Fatalf("accepted probe path %q", path)
		}
		if path == "" && (port == 0 || port > 65535) {
			t.Fatalf("accepted probe port %d", port)
		}
		if policy.interval < time.Second || policy.interval > time.Minute || policy.timeout > policy.interval || policy.timeout < 100*time.Millisecond ||
			policy.start < 0 || policy.start > 10*time.Minute || policy.limit < time.Second || policy.limit > 30*time.Minute {
			t.Fatalf("accepted timings %+v", policy)
		}
		if policy.healthy < 1 || policy.healthy > 10 || policy.unhealthy < 1 || policy.unhealthy > 10 {
			t.Fatalf("accepted thresholds %+v", policy)
		}
	})
}

func FuzzContainerSpec(f *testing.F) {
	f.Add("sk-api-r42", "registry.internal:5000/acme/api@"+digest, "node", "dist/main.js", "LOG_LEVEL", "info", "app", "api", "/app", "1000:1000", uint32(8080))
	f.Add("sk-../x", "app:latest", "sh\x00-c", "", "PATH", "x", "sk.managed", "false", "../etc", "root", uint32(0))
	f.Add("sk-api", "a@sha256:"+strings.Repeat("0", 64), strings.Repeat("a", 5000), "", "A=B", "", "", "", "relative", "0:0", uint32(70_000))
	f.Fuzz(func(t *testing.T, name, image, arg0, arg1, envName, envValue, labelKey, labelValue, workingDir, user string, port uint32) {
		spec := &agentv1.ContainerSpec{
			Name:       name,
			ImageRef:   image,
			Command:    []string{arg0, arg1},
			Env:        []*agentv1.EnvVar{{Name: envName, Value: envValue}},
			Labels:     map[string]string{labelKey: labelValue},
			WorkingDir: workingDir,
			User:       user,
			Network:    "sk-acme-prod",
			Resources:  &agentv1.Resources{CpuMillis: 500, MemoryBytes: 256 << 20},
			Mounts:     []*agentv1.Mount{{ContainerPath: "/data", Source: &agentv1.Mount_VolumeName{VolumeName: "sk-data"}}},
		}
		if port != 0 {
			spec.Ports = []*agentv1.PortMapping{{ContainerPort: port}}
		}
		gotName, config, err := containerConfig(spec, Workloads{})
		if err != nil {
			return
		}
		if gotName != name || !resourceName.MatchString(name) || !strings.Contains(image, "@sha256:") || strings.ContainsAny(image, " \n\x00") {
			t.Fatalf("accepted name %q or image %q", name, image)
		}
		host := config.HostConfig
		if !slices.Equal(host.SecurityOpt, []string{"no-new-privileges=true"}) || host.NetworkMode != "sk-acme-prod" || host.Memory != 256<<20 || host.NanoCPUs != 500_000_000 {
			t.Fatalf("confinement lost: %+v", host)
		}
		for _, mount := range host.Mounts {
			if mount.Type != "volume" && mount.Type != "tmpfs" {
				t.Fatalf("accepted a %s mount", mount.Type)
			}
		}
		for _, arg := range config.Cmd {
			if strings.ContainsRune(arg, 0) {
				t.Fatalf("accepted an argument with NUL: %q", arg)
			}
		}
		// Only the agent writes Shipkeep's own labels; the spec's labels never replace them.
		if config.Labels[docker.ManagedLabel] != "true" || config.Labels[identityLabel] != name {
			t.Fatalf("labels overridden: %v", config.Labels)
		}
		if strings.HasPrefix(labelKey, "sk.") && config.Labels[labelKey] == labelValue && labelKey != identityLabel && labelKey != docker.ManagedLabel {
			t.Fatalf("accepted label %q from the spec", labelKey)
		}
		for _, entry := range config.Env {
			if key, _, ok := strings.Cut(entry, "="); !ok || key == "" || strings.ContainsAny(key, "\x00") {
				t.Fatalf("accepted environment entry %q", entry)
			}
		}
	})
}
