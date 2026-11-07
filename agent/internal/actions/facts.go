package actions

import (
	"bufio"
	"context"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	"github.com/shipkeepdev/shipkeep/lib/buildinfo"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Versions reports the daemon versions the agent depends on.
type Versions interface {
	DockerVersion(ctx context.Context) (string, error)
}

// FactsHandler reports host facts (CollectFacts). It reads only kernel interfaces and the local
// daemons; it never runs a command.
func FactsHandler(stateDir string, versions Versions) Handler {
	return Handler{
		Plan: func(*agentv1.ActionRequest) (journal.Plan, error) {
			return journal.Plan{Version: "collect-facts-v1", Steps: []journal.Step{{
				Name:       "collect",
				RetrySafe:  true,
				Apply:      func(context.Context) (journal.Outcome, error) { return journal.Outcome{}, nil },
				Compensate: func(context.Context) error { return nil },
			}}}, nil
		},
		// Facts are cheap and current: they are read when the result is reported, not journaled.
		Result: func(journal.Outcome) *agentv1.ActionResult {
			return &agentv1.ActionResult{Result: &agentv1.ActionResult_Facts{Facts: Facts(context.Background(), stateDir, versions)}}
		},
	}
}

// Facts reads hardware and software facts of this node.
func Facts(ctx context.Context, stateDir string, versions Versions) *agentv1.NodeFacts {
	hostname, _ := os.Hostname() // an unknown hostname is reported empty
	facts := &agentv1.NodeFacts{
		Hostname:     truncate(hostname, 253),
		Os:           runtime.GOOS,
		Architecture: runtime.GOARCH,
		CpuCount:     uint32(runtime.NumCPU()), //nolint:gosec // CPU counts fit
		MemoryBytes:  memoryBytes(),
		AgentVersion: truncate(buildinfo.Version, 64),
	}
	var name unix.Utsname
	if unix.Uname(&name) == nil {
		facts.KernelVersion = truncate(unix.ByteSliceToString(name.Release[:]), 128)
	}
	var disk unix.Statfs_t
	if unix.Statfs(stateDir, &disk) == nil {
		facts.DiskBytes = disk.Blocks * uint64(disk.Bsize)     //nolint:gosec // block size is positive
		facts.DiskFreeBytes = disk.Bavail * uint64(disk.Bsize) //nolint:gosec // block size is positive
	}
	if versions != nil {
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if version, err := versions.DockerVersion(ctx); err == nil {
			facts.DockerVersion = truncate(version, 64)
		}
	}
	return facts
}

func memoryBytes() uint64 {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer file.Close() //nolint:errcheck // read-only file
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 3 && fields[0] == "MemTotal:" && fields[2] == "kB" {
			kilobytes, err := strconv.ParseUint(fields[1], 10, 64)
			if err == nil {
				return kilobytes * 1024
			}
		}
	}
	return 0
}

func truncate(value string, limit int) string {
	if len(value) > limit {
		return value[:limit]
	}
	return value
}
