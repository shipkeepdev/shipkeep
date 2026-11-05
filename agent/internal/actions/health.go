package actions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Prober reaches one container address. Tests substitute a fake.
type Prober interface {
	HTTP(ctx context.Context, address netip.AddrPort, path string) error
	TCP(ctx context.Context, address netip.AddrPort) error
}

// NetworkProber probes over the host's container networks; it never follows redirects and reads
// at most 4 KiB of a response.
type NetworkProber struct{}

// HTTP accepts any 2xx or 3xx status.
func (NetworkProber) HTTP(ctx context.Context, address netip.AddrPort, path string) error {
	client := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address.String()+path, nil)
	if err != nil {
		return fmt.Errorf("build probe: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("probe: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return fmt.Errorf("probe status %d", response.StatusCode)
	}
	return nil
}

// TCP succeeds when a connection opens.
func (NetworkProber) TCP(ctx context.Context, address netip.AddrPort) error {
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", address.String())
	if err != nil {
		return fmt.Errorf("probe: %w", err)
	}
	return connection.Close() //nolint:wrapcheck // closing a probe connection
}

type healthPolicy struct {
	path                            string
	port                            uint32
	interval, timeout, start, limit time.Duration
	healthy, unhealthy              int
}

var errUnhealthy = errors.New("container is unhealthy")

// healthCheck probes a managed container until it is healthy, unhealthy or out of time.
func healthCheck(engine Engine, prober Prober, action *agentv1.HealthCheck) (journal.Plan, error) {
	ref := action.GetContainerId()
	policy, err := parseHealth(action.GetSpec(), action.GetDeadline())
	if !containerRef.MatchString(ref) || err != nil || prober == nil {
		return journal.Plan{}, errInput
	}
	return journal.Plan{Version: "health-check-v1", Steps: []journal.Step{{
		Name:      "probe",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			container, err := managed(ctx, engine, ref)
			if errors.Is(err, docker.ErrNotFound) {
				return journal.Outcome{}, errMissing
			}
			if err != nil {
				return journal.Outcome{}, err
			}
			address, err := probeAddress(container, policy.port)
			if err != nil {
				return journal.Outcome{}, err
			}
			return probeUntil(ctx, prober, address, policy)
		},
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

func probeUntil(ctx context.Context, prober Prober, address netip.AddrPort, policy healthPolicy) (journal.Outcome, error) {
	ctx, cancel := context.WithTimeout(ctx, policy.limit)
	defer cancel()
	wait := policy.start
	successes, failures := 0, 0
	for {
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return journal.Outcome{}, errUnhealthy
		case <-timer.C:
		}
		wait = policy.interval
		attempt, stop := context.WithTimeout(ctx, policy.timeout)
		var err error
		if policy.path != "" {
			err = prober.HTTP(attempt, address, policy.path)
		} else {
			err = prober.TCP(attempt, address)
		}
		stop()
		if err == nil {
			successes, failures = successes+1, 0
			if successes >= policy.healthy {
				return journal.Outcome{ExitCode: int32(successes)}, nil
			}
			continue
		}
		successes, failures = 0, failures+1
		if failures >= policy.unhealthy {
			return journal.Outcome{}, errUnhealthy
		}
	}
}

// probeAddress picks the container's private address and its probed port.
func probeAddress(container docker.Container, port uint32) (netip.AddrPort, error) {
	names := make([]string, 0, len(container.NetworkSettings.Networks))
	for name := range container.NetworkSettings.Networks {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		address, err := netip.ParseAddr(container.NetworkSettings.Networks[name].IPAddress)
		// Only container networks: never loopback, link-local (cloud metadata) or public hosts.
		if err != nil || !address.IsPrivate() {
			continue
		}
		if port == 0 {
			tcp := []string{}
			for exposed := range container.Config.ExposedPorts {
				if number, ok := strings.CutSuffix(exposed, "/tcp"); ok {
					tcp = append(tcp, number)
				}
			}
			if len(tcp) != 1 {
				return netip.AddrPort{}, errors.New("http probe needs exactly one exposed tcp port")
			}
			value, err := strconv.ParseUint(tcp[0], 10, 16)
			if err != nil || value == 0 {
				return netip.AddrPort{}, errors.New("invalid exposed port")
			}
			port = uint32(value)
		}
		return netip.AddrPortFrom(address, uint16(port)), nil
	}
	return netip.AddrPort{}, errors.New("container has no private address")
}

func parseHealth(spec *agentv1.HealthCheckSpec, deadline *durationpb.Duration) (healthPolicy, error) {
	policy := healthPolicy{interval: 5 * time.Second, timeout: 2 * time.Second, limit: 5 * time.Minute, healthy: 1, unhealthy: 3}
	switch probe := spec.GetProbe().(type) {
	case *agentv1.HealthCheckSpec_HttpPath:
		if !strings.HasPrefix(probe.HttpPath, "/") || strings.HasPrefix(probe.HttpPath, "//") || len(probe.HttpPath) > 2048 ||
			strings.ContainsAny(probe.HttpPath, " #\\") || !printable(probe.HttpPath, 2048) {
			return policy, errInput
		}
		policy.path = probe.HttpPath
	case *agentv1.HealthCheckSpec_TcpPort:
		if probe.TcpPort == 0 || probe.TcpPort > 65535 {
			return policy, errInput
		}
		policy.port = probe.TcpPort
	default:
		return policy, errInput
	}
	for _, field := range []struct {
		value    *durationpb.Duration
		target   *time.Duration
		min, max time.Duration
	}{
		{spec.GetInterval(), &policy.interval, time.Second, time.Minute},
		{spec.GetTimeout(), &policy.timeout, 100 * time.Millisecond, time.Minute},
		{spec.GetStartPeriod(), &policy.start, 0, 10 * time.Minute},
		{deadline, &policy.limit, time.Second, 30 * time.Minute},
	} {
		if field.value == nil {
			continue
		}
		duration := field.value.AsDuration()
		if field.value.CheckValid() != nil || duration < field.min || duration > field.max {
			return policy, errInput
		}
		*field.target = duration
	}
	if healthy := spec.GetHealthyThreshold(); healthy != 0 {
		if healthy > 10 {
			return policy, errInput
		}
		policy.healthy = int(healthy)
	}
	if unhealthy := spec.GetUnhealthyThreshold(); unhealthy != 0 {
		if unhealthy > 10 {
			return policy, errInput
		}
		policy.unhealthy = int(unhealthy)
	}
	if policy.timeout > policy.interval {
		return policy, errInput
	}
	return policy, nil
}

func healthResult(outcome journal.Outcome) *agentv1.ActionResult {
	return &agentv1.ActionResult{Result: &agentv1.ActionResult_HealthCheck{HealthCheck: &agentv1.HealthCheckResult{
		Healthy: true, ConsecutiveSuccesses: uint32(max(outcome.ExitCode, 0)),
	}}}
}
