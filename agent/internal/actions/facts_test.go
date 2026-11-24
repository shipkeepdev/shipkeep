package actions

import (
	"context"
	"errors"
	"runtime"
	"testing"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

func journalOutcome() journal.Outcome { return journal.Outcome{} }

type versions struct{ fail bool }

func (v versions) DockerVersion(context.Context) (string, error) {
	if v.fail {
		return "", errors.New("daemon down")
	}
	return "29.1.3", nil
}

func TestFactsDescribeTheHostWithoutCommands(t *testing.T) {
	facts := Facts(context.Background(), t.TempDir(), versions{}, Reservation{})
	if facts.GetOs() != runtime.GOOS || facts.GetArchitecture() != runtime.GOARCH || facts.GetCpuCount() == 0 ||
		facts.GetDockerVersion() != "29.1.3" || facts.GetDiskBytes() == 0 {
		t.Fatalf("incomplete facts: %v", facts)
	}
	if Facts(context.Background(), t.TempDir(), versions{fail: true}, Reservation{}).GetDockerVersion() != "" {
		t.Fatal("an unreachable daemon must leave the version empty")
	}
	result := FactsHandler(t.TempDir(), nil, Reservation{}).Result
	if result == nil || result(journalOutcome()).GetFacts().GetOs() != runtime.GOOS {
		t.Fatal("collect_facts result missing")
	}
}

// The reservation is reported beside the machine's capacity, which stays whole (ADR 0021).
func TestFactsReportTheReservationBesideTheMachine(t *testing.T) {
	plain := Facts(context.Background(), t.TempDir(), versions{}, Reservation{})
	if plain.GetReservedCpuMillis() != 0 || plain.GetReservedMemoryBytes() != 0 {
		t.Fatalf("a node without a reservation reported one: %v", plain)
	}
	reserved := Reservation{CPUMillis: 500, MemoryBytes: 1 << 30}
	facts := Facts(context.Background(), t.TempDir(), versions{}, reserved)
	if facts.GetReservedCpuMillis() != 500 || facts.GetReservedMemoryBytes() != 1<<30 {
		t.Fatalf("reservation = %d m, %d B", facts.GetReservedCpuMillis(), facts.GetReservedMemoryBytes())
	}
	if facts.GetCpuCount() != plain.GetCpuCount() || facts.GetMemoryBytes() != plain.GetMemoryBytes() {
		t.Fatal("the reservation must not change the machine's reported capacity")
	}
	collected := FactsHandler(t.TempDir(), nil, reserved).Result(journalOutcome()).GetFacts()
	if collected.GetReservedCpuMillis() != 500 || collected.GetReservedMemoryBytes() != 1<<30 {
		t.Fatal("collect_facts dropped the reservation")
	}
}

func TestFactsReportTheRoleTheInstallerSet(t *testing.T) {
	for _, role := range []agentv1.NodeRole{agentv1.NodeRole_NODE_ROLE_SERVER, agentv1.NodeRole_NODE_ROLE_CONTROL_PLANE, agentv1.NodeRole_NODE_ROLE_CONTROL_PLANE_ONLY} {
		reservation := Reservation{Role: role}
		if got := Facts(context.Background(), t.TempDir(), versions{}, reservation).GetRole(); got != role {
			t.Errorf("hello facts: %v, want %v", got, role)
		}
		if got := FactsHandler(t.TempDir(), nil, reservation).Result(journalOutcome()).GetFacts().GetRole(); got != role {
			t.Errorf("collect_facts: %v, want %v", got, role)
		}
	}
}
