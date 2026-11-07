package agentproto_test

import (
	"slices"
	"testing"

	"github.com/shipkeepdev/shipkeep/lib/agentproto"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// The 23 actions of SPEC section 3.3. Changing this list is a contract change (CLAUDE.md, rule 2).
var specActions = []string{
	"ensure_network",
	"pull_image",
	"build_image",
	"create_container",
	"start_container",
	"stop_container",
	"remove_container",
	"ensure_volume",
	"remove_volume",
	"health_check",
	"upsert_route",
	"remove_route",
	"run_release_task",
	"exec_session",
	"backup_volume",
	"restore_volume",
	"dump_database",
	"restore_database",
	"configure_peers",
	"collect_facts",
	"upgrade_agent",
	"stop_stateful_workloads",
	"upgrade_control_plane",
}

func TestActionKindsMatchSpec(t *testing.T) {
	t.Parallel()

	got := agentproto.ActionKinds()
	if !slices.Equal(got, specActions) {
		t.Fatalf("ActionKinds() = %v\nwant %v", got, specActions)
	}
}

func TestActionKind(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		req  *agentv1.ActionRequest
		want string
	}{
		{name: "nil request", req: nil, want: ""},
		{name: "empty request", req: &agentv1.ActionRequest{}, want: ""},
		{
			name: "ensure network",
			req: &agentv1.ActionRequest{
				Action: &agentv1.ActionRequest_EnsureNetwork{
					EnsureNetwork: &agentv1.EnsureNetwork{Name: "sk-prod"},
				},
			},
			want: "ensure_network",
		},
		{
			name: "upgrade control plane",
			req: &agentv1.ActionRequest{
				Action: &agentv1.ActionRequest_UpgradeControlPlane{
					UpgradeControlPlane: &agentv1.UpgradeControlPlane{Version: "0.1.0"},
				},
			},
			want: "upgrade_control_plane",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := agentproto.ActionKind(tt.req); got != tt.want {
				t.Fatalf("ActionKind() = %q, want %q", got, tt.want)
			}
		})
	}
}
