package reporting

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Opt in with a locally available, digest-pinned image containing /usr/bin/sleep.
func TestDockerReportsOperatorStoppedAndRemovedContainer(t *testing.T) {
	image := os.Getenv("SHIPKEEP_DOCKER_TEST_IMAGE")
	if image == "" {
		t.Skip("set SHIPKEEP_DOCKER_TEST_IMAGE for disposable Docker acceptance")
	}
	if !strings.Contains(image, "@sha256:") {
		t.Fatal("test image must be digest-pinned")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	engine, err := docker.New("unix:///var/run/docker.sock")
	if err != nil {
		t.Fatal(err)
	}
	name := "sk-report-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	id, err := engine.CreateContainer(ctx, name, docker.ContainerConfig{
		Image: image, Cmd: []string{"/usr/bin/sleep", "300"}, Labels: map[string]string{docker.ManagedLabel: "true"},
		HostConfig: docker.HostConfig{NetworkMode: "none", ReadonlyRootfs: true, PidsLimit: 32, Memory: 32 << 20, SecurityOpt: []string{"no-new-privileges"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer stop()
		if err := engine.RemoveContainer(cleanup, id, false); err != nil && !errors.Is(err, docker.ErrNotFound) {
			t.Error(err)
		}
	}()
	check := func(want agentv1.ContainerStatus_State, present bool) {
		t.Helper()
		report, err := Snapshot(ctx, engine)
		if err != nil {
			t.Fatal(err)
		}
		for _, container := range report.Containers {
			if container.ContainerId == id {
				if !present || container.State != want {
					t.Fatal("incorrect observed state")
				}
				return
			}
		}
		if present {
			t.Fatal("managed container omitted")
		}
	}
	if err := engine.StartContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	check(agentv1.ContainerStatus_STATE_RUNNING, true)
	if err := engine.StopContainer(ctx, id, 0); err != nil {
		t.Fatal(err)
	}
	check(agentv1.ContainerStatus_STATE_EXITED, true)
	if err := engine.RemoveContainer(ctx, id, false); err != nil {
		t.Fatal(err)
	}
	check(agentv1.ContainerStatus_STATE_UNSPECIFIED, false)
}
