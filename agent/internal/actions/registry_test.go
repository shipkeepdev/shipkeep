package actions

import (
	"context"
	"slices"
	"testing"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// A machine that runs the control plane alone reports its facts and upgrades itself, nothing
// else: any action on workloads or routes is refused as unsupported, before it is journaled.
func TestAControlPlaneOnlyAgentHandlesNoWorkload(t *testing.T) {
	upgrader := newUpgradeNode(t).upgrader
	// Exec sessions are configured as on every agent: a control-plane-only machine still refuses them.
	sessions := NewExecSessions()
	t.Cleanup(sessions.Close)
	exec := WithExec(nil, nil, sessions)
	full := Registry(nil, nil, nil, nil, Handler{}, WithUpgrader(upgrader), exec)
	only := Registry(nil, nil, nil, nil, Handler{}, WithUpgrader(upgrader), exec, ControlPlaneOnly())
	kinds := func(handlers map[string]Handler) []string {
		names := make([]string, 0, len(handlers))
		for name := range handlers {
			names = append(names, name)
		}
		slices.Sort(names)
		return names
	}
	if got := kinds(only); !slices.Equal(got, []string{"collect_facts", "upgrade_agent"}) {
		t.Fatalf("control-plane-only handles %v", got)
	}
	if len(full) <= 2 || !slices.Contains(kinds(full), "exec_session") {
		t.Fatalf("a server handles only %v", kinds(full))
	}
	d := &Dispatcher{Journal: open(t), Handlers: only, Epoch: func() uint64 { return 3 }}
	for _, action := range []*agentv1.ActionRequest{
		{Action: &agentv1.ActionRequest_CreateContainer{CreateContainer: &agentv1.CreateContainer{}}},
		{Action: &agentv1.ActionRequest_PullImage{PullImage: &agentv1.PullImage{}}},
		{Action: &agentv1.ActionRequest_UpsertRoute{UpsertRoute: &agentv1.UpsertRoute{}}},
		{Action: &agentv1.ActionRequest_ExecSession{ExecSession: &agentv1.ExecSession{}}},
	} {
		action.ActionId, action.IdempotencyKey, action.LeaseEpoch = testID, "refused", 3
		out := &recorder{}
		d.Handle(context.Background(), action, out.send)
		if update := out.last(t); update.GetError() != errUnsupported {
			t.Errorf("%T: %v", action.GetAction(), update)
		}
	}
}
