package confirm

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
)

// Signed by Node.js exactly as the control plane signs (SPEC 3.6), with a fixed test key.
const (
	vectorKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n-----END PUBLIC KEY-----\n"
	vector    = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIwMTlkMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwZTEiLCJvcmciOiIwMTlkMDAwMC0wMDAwLTcwMDAtODAwMC0wMDAwMDAwMDAwZTIiLCJhY3Rpb24iOiJ2b2x1bWUucmVtb3ZlIiwidGFyZ2V0Ijoic2stZGF0YSIsInN1YiI6IjAxOWQwMDAwLTAwMDAtNzAwMC04MDAwLTAwMDAwMDAwMDBlMyIsImlhdCI6MTc5Mzg4MDAwMCwiZXhwIjoxNzkzODgwMzAwfQ.UxepazWNLS8BkoQIdIOvf2ol7SO3x8yHnDG8Xkk9PElGRM7LHYCroY8z45b1d-tn_ZpuhrdEgeTWCnoKvcDTAg" // gitleaks:allow (test token, fixed public test key)
	org       = "019d0000-0000-7000-8000-0000000000e2"
)

var issued = time.Unix(1793880000, 0)

func verifier(t *testing.T, at time.Time, organization string) *Verifier {
	t.Helper()
	store, err := journal.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	v, err := NewVerifier(vectorKey, organization, store)
	if err != nil {
		t.Fatal(err)
	}
	v.now = func() time.Time { return at }
	return v
}

func TestControlPlaneTokensVerifyOnceInGo(t *testing.T) {
	v := verifier(t, issued.Add(time.Minute), org)
	if err := v.Consume(context.Background(), vector, "volume.remove", "sk-data"); err != nil {
		t.Fatalf("valid control-plane token rejected: %v", err)
	}
	if err := v.Consume(context.Background(), vector, "volume.remove", "sk-data"); !errors.Is(err, ErrRejected) {
		t.Fatal("replayed token accepted")
	}
}

func TestTokensAreBoundToActionTargetOrganizationAndTime(t *testing.T) {
	for name, check := range map[string]func(*testing.T) error{
		"other target": func(t *testing.T) error {
			return verifier(t, issued, org).Consume(context.Background(), vector, "volume.remove", "sk-other")
		},
		"other action": func(t *testing.T) error {
			return verifier(t, issued, org).Consume(context.Background(), vector, "container.remove", "sk-data")
		},
		"other organization": func(t *testing.T) error {
			return verifier(t, issued, "019d0000-0000-7000-8000-0000000000ff").Consume(context.Background(), vector, "volume.remove", "sk-data")
		},
		"expired": func(t *testing.T) error {
			return verifier(t, issued.Add(5*time.Minute), org).Consume(context.Background(), vector, "volume.remove", "sk-data")
		},
		"issued in future": func(t *testing.T) error {
			return verifier(t, issued.Add(-2*time.Minute), org).Consume(context.Background(), vector, "volume.remove", "sk-data")
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := check(t); !errors.Is(err, ErrRejected) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

func TestMalformedAndForgedTokensAreRejected(t *testing.T) {
	parts := strings.Split(vector, ".")
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	_, forgedKey, _ := ed25519.GenerateKey(nil)
	forged := parts[0] + "." + parts[1] + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(forgedKey, []byte(parts[0]+"."+parts[1])))
	reordered := strings.Replace(string(payload), `"jti"`, `"zzz"`, 1)
	for name, token := range map[string]string{
		"empty":            "",
		"two parts":        parts[0] + "." + parts[1],
		"alg none":         enc(`{"alg":"none","typ":"JWT"}`) + "." + parts[1] + "." + parts[2],
		"header reordered": enc(`{"typ":"JWT","alg":"EdDSA"}`) + "." + parts[1] + "." + parts[2],
		"padded":           parts[0] + "." + parts[1] + "=." + parts[2],
		"extra claim":      parts[0] + "." + enc(strings.TrimSuffix(string(payload), "}")+`,"admin":true}`) + "." + parts[2],
		"unknown claim":    parts[0] + "." + enc(reordered) + "." + parts[2],
		"spaces":           parts[0] + "." + enc(" "+string(payload)) + "." + parts[2],
		"longer lifetime":  parts[0] + "." + enc(strings.Replace(string(payload), "1793880300", "1793883900", 1)) + "." + parts[2],
		"short signature":  parts[0] + "." + parts[1] + "." + parts[2][:40],
		"forged signature": forged,
		"oversized":        vector + strings.Repeat("A", 2048),
	} {
		t.Run(name, func(t *testing.T) {
			if err := verifier(t, issued, org).Consume(context.Background(), token, "volume.remove", "sk-data"); !errors.Is(err, ErrRejected) {
				t.Fatal("accepted a malformed or forged token")
			}
		})
	}
	if !Wellformed(vector) || Wellformed(forged[:len(forged)-4]) {
		t.Fatal("shape check disagrees with the parser")
	}
}

func FuzzParseNeverAcceptsAlteredTokens(f *testing.F) {
	f.Add(vector)
	f.Add("a.b.c")
	f.Fuzz(func(t *testing.T, token string) {
		if token == vector {
			return
		}
		claims, input, signature, ok := parse(token)
		if ok && ed25519.Verify(mustKey(t), []byte(input), signature) && claims.JTI != "" {
			t.Fatalf("altered token verified: %q", token)
		}
	})
}

func mustKey(t *testing.T) ed25519.PublicKey {
	t.Helper()
	v, err := NewVerifier(vectorKey, org, ledgerStub{})
	if err != nil {
		t.Fatal(err)
	}
	return v.key
}

type ledgerStub struct{}

func (ledgerStub) ConsumeConfirmation(context.Context, string, time.Time, time.Time) (bool, error) {
	return true, nil
}
