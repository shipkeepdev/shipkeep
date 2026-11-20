// Package metrics samples what a node measures for the control plane (ADR 0024): the node itself,
// its managed containers, and the requests Caddy answered for each host name of its routes. Every
// value is a cumulative counter or a gauge: the agent keeps nothing between samples.
package metrics

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Containers is the part of the Docker client the sampler uses.
type Containers interface {
	ManagedContainers(ctx context.Context) ([]docker.ContainerSummary, error)
	ContainerStats(ctx context.Context, id string) (docker.ContainerStats, error)
	DataRoot(ctx context.Context) (string, error)
}

// Requests is the part of the Caddy client the sampler uses.
type Requests interface {
	EnableRequestMetrics(ctx context.Context) error
	RequestMetrics(ctx context.Context) ([]byte, error)
}

// Sampler takes one sample of everything a metrics report carries.
type Sampler struct {
	Containers Containers
	Requests   Requests
	// Proc is the proc file system, /proc on a node.
	Proc   string
	Logger *slog.Logger
	// Now replaces the clock in tests.
	Now func() time.Time

	mu       sync.Mutex
	dataRoot string
}

const (
	statsTimeout = 5 * time.Second
	parallel     = 8
)

var containerName = regexp.MustCompile(`^sk-[a-z0-9-]{1,60}$`)

// Sample measures the node, its running managed containers and its route hosts. A part that fails
// is left out and logged, so that one failure does not hide the rest; when every part fails, the
// sample is an error.
func (s *Sampler) Sample(ctx context.Context) (*agentv1.MetricsReport, error) {
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	report := &agentv1.MetricsReport{SampledAt: timestamppb.New(now())}
	var failures []error
	node, err := s.node(ctx)
	if err != nil {
		failures = append(failures, err)
	} else {
		report.Node = node
	}
	containers, err := s.containers(ctx)
	if err != nil {
		failures = append(failures, err)
	} else {
		report.Containers = containers
	}
	if s.Requests != nil {
		hosts, err := s.hosts(ctx)
		if err != nil {
			failures = append(failures, err)
		} else {
			report.Hosts = hosts
		}
	}
	if len(failures) > 0 {
		s.Logger.Debug("metrics partly sampled", "error", errors.Join(failures...))
	}
	if report.Node == nil && report.Containers == nil && report.Hosts == nil {
		return nil, errors.Join(failures...)
	}
	return report, nil
}

func (s *Sampler) node(ctx context.Context) (*agentv1.NodeMetrics, error) {
	node, err := readNode(s.Proc)
	if err != nil {
		return nil, err
	}
	root, err := s.root(ctx)
	if err != nil {
		return nil, err
	}
	if node.DiskTotalBytes, node.DiskUsedBytes, err = disk(root); err != nil {
		return nil, err
	}
	return node, nil
}

// root asks Docker for its data root once.
func (s *Sampler) root(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dataRoot != "" {
		return s.dataRoot, nil
	}
	root, err := s.Containers.DataRoot(ctx)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(root, "/") {
		return "", errors.New("docker reported a relative data root")
	}
	s.dataRoot = root
	return root, nil
}

// containers samples the running managed containers, a few at a time, at most MaxContainers.
// A container whose stats fail is left out: it may have stopped between the list and its stats.
func (s *Sampler) containers(ctx context.Context) ([]*agentv1.ContainerMetrics, error) {
	summaries, err := s.Containers.ManagedContainers(ctx)
	if err != nil {
		return nil, err
	}
	type target struct{ id, name string }
	targets := []target{}
	for _, summary := range summaries {
		if summary.State != "running" || len(summary.Names) == 0 {
			continue
		}
		name := strings.TrimPrefix(summary.Names[0], "/")
		if containerName.MatchString(name) {
			targets = append(targets, target{summary.ID, name})
		}
	}
	slices.SortFunc(targets, func(a, b target) int { return strings.Compare(a.name, b.name) })
	if len(targets) > MaxContainers {
		targets = targets[:MaxContainers]
	}
	results := make([]*agentv1.ContainerMetrics, len(targets))
	slots := make(chan struct{}, parallel)
	var wait sync.WaitGroup
	for index, current := range targets {
		wait.Go(func() {
			slots <- struct{}{}
			defer func() { <-slots }()
			statsCtx, cancel := context.WithTimeout(ctx, statsTimeout)
			defer cancel()
			stats, err := s.Containers.ContainerStats(statsCtx, current.id)
			if err != nil {
				return
			}
			sample := &agentv1.ContainerMetrics{
				Name:             current.name,
				CpuSeconds:       float64(stats.CPU.Usage.Total) / float64(time.Second),
				MemoryUsedBytes:  stats.MemoryInUse(),
				MemoryLimitBytes: stats.Memory.Limit,
			}
			for _, network := range stats.Networks {
				sample.NetworkReceivedBytes += network.Received
				sample.NetworkSentBytes += network.Sent
			}
			results[index] = sample
		})
	}
	wait.Wait()
	return slices.DeleteFunc(results, func(sample *agentv1.ContainerMetrics) bool { return sample == nil }), nil
}

func (s *Sampler) hosts(ctx context.Context) ([]*agentv1.HostMetrics, error) {
	if err := s.Requests.EnableRequestMetrics(ctx); err != nil {
		return nil, err
	}
	text, err := s.Requests.RequestMetrics(ctx)
	if err != nil {
		return nil, err
	}
	return hostTotals(text), nil
}
