package actions

// Registry returns the handlers this agent build supports, keyed by ActionRequest oneof field name.
// Kinds without a handler are answered with a failed update and never journaled. Handlers arrive
// with their milestones (M1.4b, M1.4c, M1.5) together with their malicious-input tests.
func Registry() map[string]Handler {
	return map[string]Handler{}
}
