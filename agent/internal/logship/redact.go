// Package logship sends the output of managed containers to the control plane (ADR 0029).
package logship

import (
	"cmp"
	"slices"
	"strings"
)

// MinSecret is the shortest secret value that is redacted: shorter ones would mangle ordinary
// output, and are not worth hiding behind a redaction anyway.
const MinSecret = 8

// Redacted replaces a secret value in a line.
const Redacted = "[redacted]"

// Redactor removes the values of a container's secret environment variables from its lines.
type Redactor struct {
	values []string
}

// NewRedactor reads the secret values from env (Docker's NAME=value list), for the names the
// agent recorded when it created the container (actions.SecretEnvLabel).
func NewRedactor(env []string, names string) Redactor {
	secret := map[string]bool{}
	for name := range strings.SplitSeq(names, ",") {
		if name != "" {
			secret[name] = true
		}
	}
	var values []string
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if ok && secret[name] && len(value) >= MinSecret {
			values = append(values, value)
		}
	}
	// The longest first: a value that contains another is replaced whole.
	slices.SortFunc(values, func(a, b string) int { return cmp.Compare(len(b), len(a)) })
	return Redactor{values: slices.Compact(values)}
}

// Redact returns line without the secret values.
func (r Redactor) Redact(line string) string {
	for _, value := range r.values {
		line = strings.ReplaceAll(line, value, Redacted)
	}
	return line
}
