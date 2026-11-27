package actions

import (
	"maps"

	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Registry returns the handlers this agent build supports, keyed by ActionRequest oneof field name.
// Kinds without a handler are answered with a failed update and never journaled. Handlers arrive
// with their milestones together with their malicious-input tests.
func Registry(engine Engine, confirmations Confirmer, router Router, intents Intents, facts Handler, options ...Option) map[string]Handler {
	var settings handlerOptions
	for _, option := range options {
		option(&settings)
	}
	handlers := map[string]Handler{"collect_facts": facts}
	if !settings.controlPlane {
		maps.Copy(handlers, DockerHandlers(engine, confirmations, intents, options...))
		maps.Copy(handlers, RouteHandlers(router, engine, settings.routeBook, nil, settings.reservedHosts...))
	}
	if settings.builds != nil && !settings.controlPlane {
		// A control-plane-only machine never builds (ADR 0030).
		handlers["build_image"] = Handler{Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return buildImage(settings.builds, req)
		}, Result: buildResult}
	}
	if settings.upgrader != nil {
		handlers["upgrade_agent"] = UpgradeHandler(*settings.upgrader)
	}
	return handlers
}
