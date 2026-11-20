package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

func runWith(t *testing.T, engine Engine, req *agentv1.ActionRequest, options ...Option) *agentv1.ActionUpdate {
	t.Helper()
	d := &Dispatcher{Journal: open(t), Handlers: dockerHandlers(engine, confirmer{}, &fakeProber{}, nil, options...), Epoch: func() uint64 { return 3 }}
	req.ActionId = testID
	req.IdempotencyKey = "test:key"
	req.LeaseEpoch = 3
	req.DeadlineUnixMs = time.Now().Add(time.Minute).UnixMilli()
	out := &recorder{}
	d.Handle(context.Background(), req, out.send)
	return out.last(t)
}

// On the machine that hosts the control plane, application containers run in the workloads slice
// and are killed first (ADR 0021); release tasks too.
func TestContainersRunInTheWorkloadsSliceWhenConfigured(t *testing.T) {
	adj := 1000
	workloads := WithWorkloads(Workloads{Slice: "shipkeep-workloads.slice", OOMScoreAdj: &adj})
	engine := newFakeEngine()
	create := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_CreateContainer{CreateContainer: &agentv1.CreateContainer{Spec: validSpec()}}}
	if update := runWith(t, engine, create, workloads); !succeeded(update) {
		t.Fatalf("create failed: %v", update)
	}
	task := validSpec()
	task.Name = "sk-api-r42-release"
	release := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RunReleaseTask{RunReleaseTask: &agentv1.RunReleaseTask{Spec: task, Timeout: durationpb.New(time.Minute)}}}
	runWith(t, engine, release, workloads)
	if len(engine.created) != 2 {
		t.Fatalf("created %d containers", len(engine.created))
	}
	for _, config := range engine.created {
		host := config.HostConfig
		if host.CgroupParent != "shipkeep-workloads.slice" || host.OomScoreAdj == nil || *host.OomScoreAdj != 1000 {
			t.Fatalf("container outside the workloads slice: %+v", host)
		}
	}
	// The option holds a copy: changing the caller's value later does not move containers.
	adj = -1000
	if *engine.created[0].HostConfig.OomScoreAdj != 1000 {
		t.Fatal("the container's oom_score_adj follows the caller's variable")
	}
}

// Elsewhere nothing changes: Docker's default cgroup and the kernel's default kill order.
func TestContainersKeepDockerDefaultsWithoutWorkloads(t *testing.T) {
	engine := newFakeEngine()
	if update := create(t, engine, validSpec()); !succeeded(update) {
		t.Fatalf("create failed: %v", update)
	}
	host := engine.created[0].HostConfig
	if host.CgroupParent != "" || host.OomScoreAdj != nil {
		t.Fatalf("defaults changed: %+v", host)
	}
	body, err := json.Marshal(host)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "CgroupParent") || strings.Contains(string(body), "OomScoreAdj") {
		t.Fatalf("unset fields sent to Docker: %s", body)
	}
}
