package reporting

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

type engine struct {
	containers []docker.ContainerSummary
	err        error
}

func (e engine) ManagedContainers(context.Context) ([]docker.ContainerSummary, error) {
	return e.containers, e.err
}
func managed(name, state string) docker.ContainerSummary {
	return docker.ContainerSummary{ID: strings.Repeat("a", 64), Names: []string{"/" + name}, State: state, Labels: map[string]string{docker.ManagedLabel: "true", "private": "sk_test_fake_secret"}}
}

func TestSnapshotReportsStoppedAndRemovedContainersWithoutPrivateLabels(t *testing.T) {
	e := engine{containers: []docker.ContainerSummary{managed("sk-z", "running"), managed("sk-a", "exited"), {ID: "unmanaged"}}}
	report, err := Snapshot(t.Context(), e)
	if err != nil || len(report.GetContainers()) != 2 {
		t.Fatalf("snapshot: %v, %v", report, err)
	}
	if report.Containers[0].Name != "sk-a" || report.Containers[0].State != agentv1.ContainerStatus_STATE_EXITED {
		t.Fatal("stopped container was omitted")
	}
	data, err := protojson.Marshal(report)
	if err != nil || strings.Contains(string(data), "private") || strings.Contains(string(data), "sk_test_fake_secret") {
		t.Fatal("private labels leaked")
	}
	e.containers = nil
	report, err = Snapshot(t.Context(), e)
	if err != nil || len(report.Containers) != 0 {
		t.Fatal("removed container remained in snapshot")
	}
}

func TestSnapshotTreatsRemovingContainersAsAbsent(t *testing.T) {
	going := managed("sk-going", "removing")
	going.ID = strings.Repeat("b", 64)
	report, err := Snapshot(t.Context(), engine{containers: []docker.ContainerSummary{managed("sk-healthy", "running"), going}})
	if err != nil || len(report.GetContainers()) != 1 || report.Containers[0].Name != "sk-healthy" {
		t.Fatalf("a removing container changed the inventory: %v, %v", report, err)
	}
}

func TestSnapshotNeverPublishesPartialInventories(t *testing.T) {
	large := make([]docker.ContainerSummary, 257)
	for i := range large {
		large[i] = managed("sk-"+strconv.Itoa(i), "running")
	}
	if report, err := Snapshot(t.Context(), engine{containers: large}); err == nil || report != nil {
		t.Fatal("oversized inventory was truncated")
	}
	for _, container := range []docker.ContainerSummary{managed("sk-../../etc", "running"), managed("sk-a", "unrecognized"), {ID: "short", Names: []string{"/sk-a"}, Labels: map[string]string{docker.ManagedLabel: "true"}}} {
		if report, err := Snapshot(t.Context(), engine{containers: []docker.ContainerSummary{container}}); err == nil || report != nil {
			t.Fatal("invalid inventory accepted")
		}
	}
	duplicate := managed("sk-a", "running")
	if _, err := Snapshot(t.Context(), engine{containers: []docker.ContainerSummary{duplicate, duplicate}}); err == nil {
		t.Fatal("duplicate name accepted")
	}
	if report, err := Snapshot(t.Context(), engine{err: errors.New("private daemon detail")}); err == nil || report != nil || strings.Contains(err.Error(), "private") {
		t.Fatal("daemon failure became an empty snapshot or leaked")
	}
}
