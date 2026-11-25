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
	return redactor(env, func(name string) bool { return secret[name] })
}

// LegacyRedactor is for a container created before its secret names were recorded: any of its
// values may be a secret, so every one of MinSecret bytes or more is redacted. Redeploying the
// application gives it exact redaction.
func LegacyRedactor(env []string) Redactor {
	return redactor(env, func(string) bool { return true })
}

func redactor(env []string, secret func(name string) bool) Redactor {
	var values []string
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || !secret(name) {
			continue
		}
		if len(value) >= MinSecret {
			values = append(values, value)
		}
		// Output comes line by line: each line of a multiline value is a value of its own.
		if strings.ContainsAny(value, "\r\n") {
			for line := range strings.SplitSeq(value, "\n") {
				if line = strings.TrimSuffix(line, "\r"); len(line) >= MinSecret {
					values = append(values, line)
				}
			}
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

// RedactCutEnd redacts the start of a secret value that a line cut at its bound ends with: the
// rest of the value was cut away, so Redact cannot match it whole. It runs on the line as read,
// before Redact, and takes the longest such start over all values; one shorter than MinSecret is
// left, like a short value. Its time is linear in the line and the values.
func (r Redactor) RedactCutEnd(line string) string {
	longest := 0
	for _, value := range r.values {
		longest = max(longest, cutStart(line, value))
	}
	if longest < MinSecret {
		return line
	}
	return line[:len(line)-longest] + Redacted
}

// cutStart returns the length of the longest proper prefix of value that line ends with, by the
// Knuth-Morris-Pratt failure function.
func cutStart(line, value string) int {
	// Only the last len(value)-1 bytes can hold a proper prefix: the whole value never matches.
	if start := len(line) - (len(value) - 1); start > 0 {
		line = line[start:]
	}
	fail := make([]int, len(value))
	for i, k := 1, 0; i < len(value); i++ {
		for k > 0 && value[i] != value[k] {
			k = fail[k-1]
		}
		if value[i] == value[k] {
			k++
		}
		fail[i] = k
	}
	k := 0
	for i := range len(line) {
		for k > 0 && line[i] != value[k] {
			k = fail[k-1]
		}
		if line[i] == value[k] {
			k++
		}
	}
	return k
}
