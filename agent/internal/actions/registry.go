package actions

import "maps"

// Registry returns the handlers this agent build supports, keyed by ActionRequest oneof field name.
// Kinds without a handler are answered with a failed update and never journaled. Handlers arrive
// with their milestones together with their malicious-input tests.
func Registry(engine Engine, confirmations Confirmer, router Router, intents Intents, facts Handler) map[string]Handler {
	handlers := map[string]Handler{"collect_facts": facts}
	maps.Copy(handlers, DockerHandlers(engine, confirmations, intents))
	maps.Copy(handlers, RouteHandlers(router, nil))
	return handlers
}
