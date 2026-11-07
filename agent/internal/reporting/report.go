// Package reporting produces complete, bounded observations without changing workloads.
package reporting

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Engine exposes one read-only snapshot of managed containers, including stopped ones.
type Engine interface {
	ManagedContainers(context.Context) ([]docker.ContainerSummary, error)
}

var containerID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var containerName = regexp.MustCompile(`^sk-[a-z0-9-]{1,60}$`)

// Snapshot never truncates: an incomplete inventory must not mark omitted allocations missing.
// Only the management label is transmitted; arbitrary Docker labels may contain credentials.
func Snapshot(ctx context.Context, engine Engine) (*agentv1.StateReport, error) {
	containers, err := engine.ManagedContainers(ctx)
	if err != nil {
		return nil, errors.New("cannot observe managed containers")
	}
	report := &agentv1.StateReport{}
	names := make(map[string]bool)
	for _, container := range containers {
		if container.Labels[docker.ManagedLabel] != "true" {
			continue
		}
		if len(container.Names) != 1 || !containerID.MatchString(container.ID) {
			return nil, errors.New("invalid managed container identity")
		}
		// Docker reports `removing` while deleting a container, possibly for a long time when the
		// removal is stuck. The container is going away, so it counts as absent: one such container
		// must not suppress the inventory of every other one.
		if container.State == "removing" {
			continue
		}
		name := strings.TrimPrefix(container.Names[0], "/")
		state := map[string]agentv1.ContainerStatus_State{
			"created": agentv1.ContainerStatus_STATE_CREATED, "running": agentv1.ContainerStatus_STATE_RUNNING,
			"paused": agentv1.ContainerStatus_STATE_PAUSED, "restarting": agentv1.ContainerStatus_STATE_RESTARTING,
			"exited": agentv1.ContainerStatus_STATE_EXITED, "dead": agentv1.ContainerStatus_STATE_DEAD,
		}[container.State]
		if !containerName.MatchString(name) || names[name] || state == agentv1.ContainerStatus_STATE_UNSPECIFIED || len(report.Containers) >= 256 {
			return nil, errors.New("invalid or oversized managed container inventory")
		}
		names[name] = true
		report.Containers = append(report.Containers, &agentv1.ContainerStatus{
			ContainerId: container.ID, Name: name, State: state,
			Labels: map[string]string{docker.ManagedLabel: "true"},
		})
	}
	sort.Slice(report.Containers, func(i, j int) bool { return report.Containers[i].Name < report.Containers[j].Name })
	return report, nil
}
