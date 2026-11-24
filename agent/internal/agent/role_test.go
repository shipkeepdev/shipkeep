package agent

import (
	"testing"

	"github.com/shipkeepdev/shipkeep/agent/internal/config"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

func TestTheReportedRoleComesFromTheConfiguration(t *testing.T) {
	for role, want := range map[string]agentv1.NodeRole{
		"":                          agentv1.NodeRole_NODE_ROLE_SERVER,
		config.RoleServer:           agentv1.NodeRole_NODE_ROLE_SERVER,
		config.RoleControlPlane:     agentv1.NodeRole_NODE_ROLE_CONTROL_PLANE,
		config.RoleControlPlaneOnly: agentv1.NodeRole_NODE_ROLE_CONTROL_PLANE_ONLY,
	} {
		if got := nodeRole(role); got != want {
			t.Errorf("%q: %v, want %v", role, got, want)
		}
	}
}
