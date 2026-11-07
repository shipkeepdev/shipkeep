package actions

import (
	"context"
	"errors"
	"runtime"
	"testing"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
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
	facts := Facts(context.Background(), t.TempDir(), versions{})
	if facts.GetOs() != runtime.GOOS || facts.GetArchitecture() != runtime.GOARCH || facts.GetCpuCount() == 0 ||
		facts.GetDockerVersion() != "29.1.3" || facts.GetDiskBytes() == 0 {
		t.Fatalf("incomplete facts: %v", facts)
	}
	if Facts(context.Background(), t.TempDir(), versions{fail: true}).GetDockerVersion() != "" {
		t.Fatal("an unreachable daemon must leave the version empty")
	}
	result := FactsHandler(t.TempDir(), nil).Result
	if result == nil || result(journalOutcome()).GetFacts().GetOs() != runtime.GOOS {
		t.Fatal("collect_facts result missing")
	}
}
