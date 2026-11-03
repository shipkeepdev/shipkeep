// Package secret holds wrapper types for sensitive values. They redact themselves whenever they
// are formatted, logged or serialized, so a secret can only leak through an explicit Expose()
// call (CLAUDE.md, rule 8).
package secret

import (
	"encoding"
	"encoding/json"
	"fmt"
	"log/slog"
)

// Redacted is what every secret renders as outside of Expose().
const Redacted = "[REDACTED]"

// String is a secret text value such as a token, a password or a private key.
type String struct {
	value string
}

// NewString wraps a sensitive value.
func NewString(value string) String {
	return String{value: value}
}

// Expose returns the raw value. Call it only at the point of use (a TLS config, an HTTP header),
// never to log or store it.
func (s String) Expose() string {
	return s.value
}

// IsZero reports whether no value is set.
func (s String) IsZero() bool {
	return s.value == ""
}

// Equal compares two secrets in constant time with respect to their content.
func (s String) Equal(other String) bool {
	return constantTimeEqual(s.value, other.value)
}

// String implements fmt.Stringer and always redacts.
func (s String) String() string { return Redacted }

// GoString implements fmt.GoStringer (%#v) and always redacts.
func (s String) GoString() string { return "secret.String(" + Redacted + ")" }

// Format implements fmt.Formatter so %v, %s, %q, %x and %+v all redact.
func (s String) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, Redacted)
}

// LogValue implements slog.LogValuer.
func (s String) LogValue() slog.Value {
	return slog.StringValue(Redacted)
}

// MarshalJSON implements json.Marshaler.
func (s String) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(Redacted)
	if err != nil {
		return nil, fmt.Errorf("secret: encode JSON: %w", err)
	}
	return data, nil
}

// MarshalText implements encoding.TextMarshaler (used by YAML and other text encoders).
func (s String) MarshalText() ([]byte, error) {
	return []byte(Redacted), nil
}

// UnmarshalJSON accepts a plain JSON string so secrets can be read from configuration.
func (s *String) UnmarshalJSON(data []byte) error {
	var v string
	if err := json.Unmarshal(data, &v); err != nil {
		return fmt.Errorf("secret: decode JSON: %w", err)
	}
	s.value = v
	return nil
}

// UnmarshalText accepts plain text (YAML scalars decode through this).
func (s *String) UnmarshalText(text []byte) error {
	s.value = string(text)
	return nil
}

var (
	_ fmt.Stringer             = String{}
	_ fmt.GoStringer           = String{}
	_ fmt.Formatter            = String{}
	_ slog.LogValuer           = String{}
	_ json.Marshaler           = String{}
	_ encoding.TextMarshaler   = String{}
	_ json.Unmarshaler         = (*String)(nil)
	_ encoding.TextUnmarshaler = (*String)(nil)
)

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range len(a) {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
