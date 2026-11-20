package actions

import "maps"

// Registry returns the handlers this agent build supports, keyed by ActionRequest oneof field name.
// Kinds without a handler are answered with a failed update and never journaled. Handlers arrive
// with their milestones together with their malicious-input tests.
func Registry(engine Engine, confirmations Confirmer, router Router, intents Intents, facts Handler, options ...Option) map[string]Handler {
	var settings handlerOptions
	for _, option := range options {
		option(&settings)
	}
	handlers := map[string]Handler{"collect_facts": facts}
	maps.Copy(handlers, DockerHandlers(engine, confirmations, intents, options...))
	maps.Copy(handlers, RouteHandlers(router, engine, nil, settings.reservedHosts...))
	return handlers
}
