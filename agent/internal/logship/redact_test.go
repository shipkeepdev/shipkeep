package logship

import (
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

func TestRedactorRemovesSecretValuesOnly(t *testing.T) {
	env := []string{"DATABASE_URL=postgres://app:hunter2hunter2@db/app", "TOKEN=sk_fake_abcdefgh", "PIN=1234", "PUBLIC_URL=https://example.com", "BROKEN"}
	r := NewRedactor(env, "DATABASE_URL,TOKEN,PIN,MISSING")
	got := r.Redact("connect postgres://app:hunter2hunter2@db/app with sk_fake_abcdefgh at https://example.com pin 1234")
	if got != "connect [redacted] with [redacted] at https://example.com pin 1234" {
		t.Fatalf("got %q", got)
	}
	if NewRedactor(env, "").Redact("sk_fake_abcdefgh") != "sk_fake_abcdefgh" {
		t.Fatal("a variable not named secret was redacted")
	}
}

func TestRedactorReplacesTheLongestValueFirst(t *testing.T) {
	r := NewRedactor([]string{"A=abcdefgh", "B=abcdefgh-and-more"}, "A,B")
	if got := r.Redact("x abcdefgh-and-more y abcdefgh"); got != "x [redacted] y [redacted]" {
		t.Fatalf("got %q", got)
	}
}

func TestRedactorMasksEachLineOfAMultilineSecret(t *testing.T) {
	key := "line-one-of-the-key\r\nline-two-of-the-key\nshort\n"
	r := NewRedactor([]string{"KEY=" + key}, "KEY")
	for _, line := range []string{"line-one-of-the-key", "line-two-of-the-key", "prefix line-two-of-the-key suffix"} {
		if got := r.Redact(line); strings.Contains(got, "of-the-key") {
			t.Errorf("%q came out as %q", line, got)
		}
	}
	// A line of the secret shorter than MinSecret is left, like any short value.
	if r.Redact("short") != "short" {
		t.Error("a short line was redacted")
	}
}

func TestRedactorWithoutNamesMasksEveryValue(t *testing.T) {
	// A container created before its secret names were recorded: every value of MinSecret bytes
	// or more is masked, since any of them may be a secret.
	r := LegacyRedactor([]string{"TOKEN=sk_fake_legacy_secret", "MODE=production", "PORT=8080"})
	if got := r.Redact("token=sk_fake_legacy_secret mode=production port=8080"); got != "token=[redacted] mode=[redacted] port=8080" {
		t.Fatalf("got %q", got)
	}
}

func TestRedactorMasksTheStartOfASecretAtTheEndOfACutLine(t *testing.T) {
	r := NewRedactor([]string{"TOKEN=sk_fake_cut_secret_value"}, "TOKEN")
	// The line was cut inside the secret: what is left of it is its start.
	if got := r.RedactCut("prefix sk_fake_cut_sec"); got != "prefix "+Redacted {
		t.Fatalf("got %q", got)
	}
	// Under MinSecret bytes of it, nothing is masked: it could be any text.
	if got := r.RedactCut("prefix sk_fake"); got != "prefix sk_fake" {
		t.Fatalf("got %q", got)
	}
	if got := r.RedactCut("nothing secret here"); got != "nothing secret here" {
		t.Fatalf("got %q", got)
	}
}

// The longest start wins over the order of the values, and a shorter value inside that start does
// not hide the rest of it.
func TestRedactorMasksTheLongestStartOverAllValues(t *testing.T) {
	r := NewRedactor([]string{"A=sk_fake_long_secret_value", "B=sk_fake_"}, "A,B")
	if got := r.RedactCut("log sk_fake_long_sec"); got != "log "+Redacted {
		t.Fatalf("got %q", got)
	}
}

// A cut line that ends with a whole value loses all of it, even when its end is also the start of
// a value: the same one or another (found in review of #482).
func TestRedactorMasksAWholeValueThatEndsACutLine(t *testing.T) {
	same := NewRedactor([]string{"TOKEN=abcdefgh_abcdefgh"}, "TOKEN")
	if got := same.RedactCut("log abcdefgh_abcdefgh"); got != "log "+Redacted {
		t.Fatalf("same value: %q", got)
	}
	other := NewRedactor([]string{"X=sk_fake_xyz_12345678", "Y=12345678_rest"}, "X,Y")
	if got := other.RedactCut("log sk_fake_xyz_12345678"); got != "log "+Redacted {
		t.Fatalf("other value: %q", got)
	}
}

// Occurrences that overlap are redacted whole, not only the first of them.
func TestRedactorMasksOverlappingOccurrences(t *testing.T) {
	r := NewRedactor([]string{"T=abababab"}, "T")
	if got := r.Redact("x ababababab y"); got != "x "+Redacted+" y" {
		t.Fatalf("got %q", got)
	}
}

// The spans match a byte-by-byte scan of every position, on random lines and values over a small
// alphabet, where values overlap themselves and each other.
func TestRedactorSpansMatchAScanOfEveryPosition(t *testing.T) {
	random := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // a seeded generator keeps the cases reproducible
	word := func(low, high int) string {
		out := make([]byte, low+random.IntN(high-low+1))
		for i := range out {
			out[i] = "ab"[random.IntN(2)]
		}
		return string(out)
	}
	for range 20000 {
		env := []string{"A=" + word(MinSecret, 12), "B=" + word(MinSecret, 12)}
		r := NewRedactor(env, "A,B")
		line, cut := word(0, 40), random.IntN(2) == 0
		masked := make([]bool, len(line))
		for _, entry := range env {
			value := entry[2:]
			for i := 0; i+len(value) <= len(line); i++ {
				if line[i:i+len(value)] == value {
					for j := i; j < i+len(value); j++ {
						masked[j] = true
					}
				}
			}
			for size := min(len(value)-1, len(line)); cut && size >= MinSecret; size-- {
				if strings.HasSuffix(line, value[:size]) {
					for j := len(line) - size; j < len(line); j++ {
						masked[j] = true
					}
					break
				}
			}
		}
		var want []span
		for i := range masked {
			switch {
			case !masked[i]:
			case len(want) > 0 && want[len(want)-1].end == i:
				want[len(want)-1].end++
			default:
				want = append(want, span{i, i + 1})
			}
		}
		if got := r.spans(line, cut); !slices.Equal(got, want) {
			t.Fatalf("env %q line %q cut %v: spans %v, want %v", env, line, cut, got, want)
		}
	}
}
