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
	values []secretValue
}

// secretValue is one value to redact, with its Knuth-Morris-Pratt failure function: fail[i] is
// the length of the longest proper prefix of text[:i+1] that is also its suffix.
type secretValue struct {
	text string
	fail []int32
}

// span is a part of a line to redact, from start to end (exclusive).
type span struct{ start, end int }

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
// application creates new containers, which get exact redaction.
func LegacyRedactor(env []string) Redactor {
	return redactor(env, func(string) bool { return true })
}

func redactor(env []string, secret func(name string) bool) Redactor {
	var texts []string
	for _, entry := range env {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || !secret(name) {
			continue
		}
		if len(value) >= MinSecret {
			texts = append(texts, value)
		}
		// Output comes line by line, without its line ends: each line of a multiline value is a
		// value of its own.
		if strings.ContainsAny(value, "\r\n") {
			for line := range strings.SplitSeq(value, "\n") {
				if line = strings.TrimSuffix(line, "\r"); len(line) >= MinSecret {
					texts = append(texts, line)
				}
			}
		}
	}
	slices.Sort(texts)
	texts = slices.Compact(texts)
	values := make([]secretValue, 0, len(texts))
	for _, text := range texts {
		values = append(values, secretValue{text: text, fail: failure(text)})
	}
	return Redactor{values: values}
}

func failure(text string) []int32 {
	fail := make([]int32, len(text))
	var k int32
	for i := 1; i < len(text); i++ {
		for k > 0 && text[i] != text[k] {
			k = fail[k-1]
		}
		if text[i] == text[k] {
			k++
		}
		fail[i] = k
	}
	return fail
}

// Redact returns line without the secret values. Every occurrence is redacted, overlapping ones
// included, and occurrences that overlap or touch become one "[redacted]".
func (r Redactor) Redact(line string) string {
	return redact(line, r.spans(line, false))
}

// RedactCut is Redact for a line cut at its bound: a start of a value that the line ends with,
// MinSecret bytes or more of it, is redacted too, since the rest of the value was cut away. One
// shorter than MinSecret is left, like a short value.
func (r Redactor) RedactCut(line string) string {
	return redact(line, r.spans(line, true))
}

// spans returns the parts of line to redact, sorted and merged. Each value is matched in one pass
// over the line as read, so the time is linear in the line and the values, whatever they hold.
func (r Redactor) spans(line string, cut bool) []span {
	var found []span
	for _, value := range r.values {
		if !cut && !strings.Contains(line, value.text) {
			continue
		}
		found = value.match(found, line, cut)
	}
	if len(found) == 0 {
		return nil
	}
	slices.SortFunc(found, func(a, b span) int { return cmp.Compare(a.start, b.start) })
	merged := found[:1]
	for _, next := range found[1:] {
		if last := &merged[len(merged)-1]; next.start <= last.end {
			last.end = max(last.end, next.end)
		} else {
			merged = append(merged, next)
		}
	}
	return merged
}

// match appends the spans of every occurrence of the value in line and, when the line was cut,
// of the longest proper prefix of the value that it ends with.
func (v secretValue) match(found []span, line string, cut bool) []span {
	var k int32
	for i := range len(line) {
		for k > 0 && line[i] != v.text[k] {
			k = v.fail[k-1]
		}
		if line[i] == v.text[k] {
			k++
		}
		if int(k) == len(v.text) {
			found = append(found, span{i + 1 - len(v.text), i + 1})
			k = v.fail[k-1]
		}
	}
	if cut && k >= MinSecret {
		found = append(found, span{len(line) - int(k), len(line)})
	}
	return found
}

func redact(line string, spans []span) string {
	if len(spans) == 0 {
		return line
	}
	var out strings.Builder
	at := 0
	for _, s := range spans {
		out.WriteString(line[at:s.start])
		out.WriteString(Redacted)
		at = s.end
	}
	out.WriteString(line[at:])
	return out.String()
}
