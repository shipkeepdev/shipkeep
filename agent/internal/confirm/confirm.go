// Package confirm verifies confirmation tokens for destructive actions (SPEC 3.6).
//
// The parser is deliberately as strict as the control plane's: one exact header, the exact claim
// set in a fixed order, canonical base64url without padding, a 64-byte Ed25519 signature and at
// most 2 KiB. Anything else is rejected before the signature is even checked.
package confirm

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"regexp"
	"strings"
	"time"
)

const (
	maxToken = 2048
	ttl      = 300
	skew     = 60 * time.Second
)

// ErrRejected is the single answer for every invalid, foreign, expired or replayed token.
var ErrRejected = errors.New("confirmation rejected")

var (
	header = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	uuidV7 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	action = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`)
	target = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,128}$`)
)

// Claims of a confirmation token, in the canonical order the control plane signs them.
type Claims struct {
	JTI    string `json:"jti"`
	Org    string `json:"org"`
	Action string `json:"action"`
	Target string `json:"target"`
	Sub    string `json:"sub"`
	IAT    int64  `json:"iat"`
	EXP    int64  `json:"exp"`
}

// Ledger records each token id once until it expires (the journal's used_confirmations table).
type Ledger interface {
	ConsumeConfirmation(ctx context.Context, id string, expires, now time.Time) (bool, error)
}

// Verifier checks tokens signed by the installation key received at enrollment.
type Verifier struct {
	key    ed25519.PublicKey
	org    string
	ledger Ledger
	now    func() time.Time
}

// NewVerifier parses the PEM public key from the enrollment bundle.
func NewVerifier(publicKeyPEM, organizationID string, ledger Ledger) (*Verifier, error) {
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil || block.Type != "PUBLIC KEY" || !uuidV7.MatchString(organizationID) || ledger == nil {
		return nil, errors.New("invalid confirmation key")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, errors.New("invalid confirmation key")
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("confirmation key is not Ed25519")
	}
	return &Verifier{key: key, org: organizationID, ledger: ledger, now: time.Now}, nil
}

// Wellformed reports whether token has the exact SPEC 3.6 shape. It touches no state, so plans can
// reject malformed tokens before journaling.
func Wellformed(token string) bool {
	_, _, _, ok := parse(token)
	return ok
}

// Consume verifies token for one action on one target and spends it. It must run inside the
// journaled step that performs the destructive change.
func (v *Verifier) Consume(ctx context.Context, token, wantAction, wantTarget string) error {
	claims, input, signature, ok := parse(token)
	now := v.now()
	if !ok || !ed25519.Verify(v.key, []byte(input), signature) ||
		claims.Org != v.org || claims.Action != wantAction || claims.Target != wantTarget ||
		time.Unix(claims.IAT, 0).After(now.Add(skew)) || !now.Before(time.Unix(claims.EXP, 0)) {
		return ErrRejected
	}
	spent, err := v.ledger.ConsumeConfirmation(ctx, claims.JTI, time.Unix(claims.EXP, 0), now)
	if err != nil || !spent {
		return ErrRejected
	}
	return nil
}

func parse(token string) (Claims, string, []byte, bool) {
	parts := strings.Split(token, ".")
	if len(token) > maxToken || len(parts) != 3 || parts[0] != header {
		return Claims{}, "", nil, false
	}
	payload, ok := decode(parts[1])
	signature, okSignature := decode(parts[2])
	if !ok || !okSignature || len(signature) != ed25519.SignatureSize {
		return Claims{}, "", nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var claims Claims
	if decoder.Decode(&claims) != nil || decoder.More() || !valid(claims) {
		return Claims{}, "", nil, false
	}
	// Equivalent but differently encoded payloads (order, spacing, escapes) are refused.
	canonical, err := encode(claims)
	if err != nil || !bytes.Equal(canonical, payload) {
		return Claims{}, "", nil, false
	}
	return claims, parts[0] + "." + parts[1], signature, true
}

func valid(c Claims) bool {
	return uuidV7.MatchString(c.JTI) && uuidV7.MatchString(c.Org) && uuidV7.MatchString(c.Sub) &&
		action.MatchString(c.Action) && len(c.Action) <= 64 && target.MatchString(c.Target) &&
		c.IAT > 0 && c.EXP-c.IAT == ttl
}

func encode(c Claims) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(c); err != nil {
		return nil, err //nolint:wrapcheck // only compared, never surfaced
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func decode(value string) ([]byte, bool) {
	data, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != value {
		return nil, false
	}
	return data, true
}
