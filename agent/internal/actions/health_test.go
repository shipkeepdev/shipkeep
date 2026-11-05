package actions

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

type fakeProber struct {
	mu        sync.Mutex
	results   []error
	addresses []netip.AddrPort
}

func (p *fakeProber) next(address netip.AddrPort) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.addresses = append(p.addresses, address)
	if len(p.results) == 0 {
		return nil
	}
	result := p.results[0]
	p.results = p.results[1:]
	return result
}

func (p *fakeProber) HTTP(_ context.Context, address netip.AddrPort, _ string) error {
	return p.next(address)
}
func (p *fakeProber) TCP(_ context.Context, address netip.AddrPort) error { return p.next(address) }

func healthEngine(ip string, ports ...string) *fakeEngine {
	engine := newFakeEngine()
	container := docker.Container{ID: strings.Repeat("b", 64), Name: "/sk-api-r42"}
	container.Config.Labels = map[string]string{docker.ManagedLabel: "true"}
	container.Config.ExposedPorts = map[string]struct{}{}
	for _, port := range ports {
		container.Config.ExposedPorts[port] = struct{}{}
	}
	container.NetworkSettings.Networks = map[string]struct {
		IPAddress string `json:"IPAddress"`
	}{"sk-acme": {IPAddress: ip}}
	engine.containers = append(engine.containers, container)
	return engine
}

func probe(t *testing.T, engine *fakeEngine, prober Prober, spec *agentv1.HealthCheckSpec, deadline time.Duration) *agentv1.ActionUpdate {
	t.Helper()
	d := &Dispatcher{Journal: open(t), Handlers: dockerHandlers(engine, nil, prober, nil), Epoch: func() uint64 { return 3 }}
	out := &recorder{}
	d.Handle(context.Background(), &agentv1.ActionRequest{ActionId: testID, IdempotencyKey: "health", LeaseEpoch: 3, DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
		Action: &agentv1.ActionRequest_HealthCheck{HealthCheck: &agentv1.HealthCheck{ContainerId: "sk-api-r42", Spec: spec, Deadline: durationpb.New(deadline)}}}, out.send)
	return out.last(t)
}

func fast(spec *agentv1.HealthCheckSpec) *agentv1.HealthCheckSpec {
	spec.Interval, spec.Timeout = durationpb.New(time.Second), durationpb.New(100*time.Millisecond)
	return spec
}

func TestHealthCheckReachesThresholdOnTheExposedPort(t *testing.T) {
	prober := &fakeProber{results: []error{errors.New("starting"), nil, nil}}
	spec := fast(&agentv1.HealthCheckSpec{Probe: &agentv1.HealthCheckSpec_HttpPath{HttpPath: "/health"}, HealthyThreshold: 2})
	update := probe(t, healthEngine("172.18.0.5", "8080/tcp"), prober, spec, 30*time.Second)
	if !succeeded(update) || update.GetResult().GetHealthCheck().GetConsecutiveSuccesses() != 2 {
		t.Fatalf("health check did not pass: %v", update)
	}
	if prober.addresses[0] != netip.MustParseAddrPort("172.18.0.5:8080") {
		t.Fatalf("probed %v", prober.addresses[0])
	}
}

func TestHealthCheckFailsWhenUnhealthyOrOnlyPublicAddresses(t *testing.T) {
	failing := &fakeProber{results: []error{errors.New("a"), errors.New("b")}}
	spec := fast(&agentv1.HealthCheckSpec{Probe: &agentv1.HealthCheckSpec_TcpPort{TcpPort: 5432}, UnhealthyThreshold: 2})
	if succeeded(probe(t, healthEngine("172.18.0.5"), failing, spec, 30*time.Second)) {
		t.Fatal("unhealthy container reported healthy")
	}
	for _, ip := range []string{"169.254.169.254", "127.0.0.1", "8.8.8.8", ""} {
		prober := &fakeProber{}
		if succeeded(probe(t, healthEngine(ip, "8080/tcp"), prober, spec, 30*time.Second)) || len(prober.addresses) != 0 {
			t.Fatalf("probed non-private address %q", ip)
		}
	}
	ambiguous := &fakeProber{}
	if succeeded(probe(t, healthEngine("10.0.0.2", "8080/tcp", "9090/tcp"), ambiguous, fast(&agentv1.HealthCheckSpec{Probe: &agentv1.HealthCheckSpec_HttpPath{HttpPath: "/"}}), 30*time.Second)) {
		t.Fatal("http probe guessed among several ports")
	}
}

func TestHealthCheckRejectsMaliciousSpecs(t *testing.T) {
	for name, spec := range map[string]*agentv1.HealthCheckSpec{
		"no probe":           {},
		"relative path":      {Probe: &agentv1.HealthCheckSpec_HttpPath{HttpPath: "health"}},
		"absolute url":       {Probe: &agentv1.HealthCheckSpec_HttpPath{HttpPath: "//evil.example.com/"}},
		"space":              {Probe: &agentv1.HealthCheckSpec_HttpPath{HttpPath: "/a b"}},
		"control character":  {Probe: &agentv1.HealthCheckSpec_HttpPath{HttpPath: "/a\r\nHost: evil"}},
		"oversized path":     {Probe: &agentv1.HealthCheckSpec_HttpPath{HttpPath: "/" + strings.Repeat("a", 2048)}},
		"port zero":          {Probe: &agentv1.HealthCheckSpec_TcpPort{TcpPort: 0}},
		"port overflow":      {Probe: &agentv1.HealthCheckSpec_TcpPort{TcpPort: 70000}},
		"tiny interval":      {Probe: &agentv1.HealthCheckSpec_TcpPort{TcpPort: 80}, Interval: durationpb.New(time.Millisecond)},
		"timeout > interval": {Probe: &agentv1.HealthCheckSpec_TcpPort{TcpPort: 80}, Interval: durationpb.New(time.Second), Timeout: durationpb.New(2 * time.Second)},
		"threshold storm":    {Probe: &agentv1.HealthCheckSpec_TcpPort{TcpPort: 80}, HealthyThreshold: 1000},
	} {
		t.Run(name, func(t *testing.T) {
			prober := &fakeProber{}
			if update := probe(t, healthEngine("10.0.0.2", "80/tcp"), prober, spec, time.Minute); update.GetError() != errInvalid || len(prober.addresses) != 0 {
				t.Fatalf("accepted: %v", update)
			}
		})
	}
	if update := probe(t, healthEngine("10.0.0.2"), &fakeProber{}, &agentv1.HealthCheckSpec{Probe: &agentv1.HealthCheckSpec_TcpPort{TcpPort: 80}}, time.Hour); update.GetError() != errInvalid {
		t.Fatal("accepted a one-hour deadline")
	}
}

func TestReleaseTaskRunsOnceAndCleansUp(t *testing.T) {
	release := func(engine *fakeEngine, timeout time.Duration) *agentv1.ActionUpdate {
		d := &Dispatcher{Journal: open(t), Handlers: dockerHandlers(engine, nil, &fakeProber{}, nil), Epoch: func() uint64 { return 3 }}
		out := &recorder{}
		spec := validSpec()
		spec.Name = "sk-api-migrate"
		d.Handle(context.Background(), &agentv1.ActionRequest{ActionId: testID, IdempotencyKey: "release", LeaseEpoch: 3, DeadlineUnixMs: time.Now().Add(time.Minute).UnixMilli(),
			Action: &agentv1.ActionRequest_RunReleaseTask{RunReleaseTask: &agentv1.RunReleaseTask{Spec: spec, Timeout: durationpb.New(timeout)}}}, out.send)
		return out.last(t)
	}
	engine := newFakeEngine()
	engine.exitCode = 3
	update := release(engine, time.Minute)
	if !succeeded(update) || update.GetResult().GetReleaseTask().GetExitCode() != 3 {
		t.Fatalf("release task: %v", update)
	}
	if engine.created[0].HostConfig.RestartPolicy.Name != "no" || len(engine.started) != 1 || len(engine.containers) != 0 {
		t.Fatalf("release task not run once and removed: %+v", engine)
	}
	hanging := newFakeEngine()
	hanging.hang = true
	if update := release(hanging, time.Second); succeeded(update) || len(hanging.stopped) != 1 || len(hanging.containers) != 0 {
		t.Fatalf("timed out task not killed and removed: %v %v", update, hanging.stopped)
	}
	foreign := newFakeEngine()
	foreign.containers = append(foreign.containers, docker.Container{ID: "x", Name: "/sk-api-migrate"})
	if succeeded(release(foreign, time.Minute)) || len(foreign.started) != 0 {
		t.Fatal("ran a container Shipkeep does not manage")
	}
	if update := release(newFakeEngine(), 2*time.Hour); update.GetError() != errInvalid {
		t.Fatal("accepted a two-hour timeout")
	}
}
