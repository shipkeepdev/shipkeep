package logship

import (
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
	if got := r.RedactCutEnd("prefix sk_fake_cut_sec"); got != "prefix "+Redacted {
		t.Fatalf("got %q", got)
	}
	// Under MinSecret bytes of it, nothing is masked: it could be any text.
	if got := r.RedactCutEnd("prefix sk_fake"); got != "prefix sk_fake" {
		t.Fatalf("got %q", got)
	}
	if got := r.RedactCutEnd("nothing secret here"); got != "nothing secret here" {
		t.Fatalf("got %q", got)
	}
}

// The longest start wins over the order of the values, and a shorter value inside that start does
// not hide the rest of it.
func TestRedactorMasksTheLongestStartOverAllValues(t *testing.T) {
	r := NewRedactor([]string{"A=sk_fake_long_secret_value", "B=sk_fake_"}, "A,B")
	if got := r.Redact(r.RedactCutEnd("log sk_fake_long_sec")); got != "log "+Redacted {
		t.Fatalf("got %q", got)
	}
}

// The failure function matches a scan of every suffix, on values that overlap themselves, where a
// naive restart goes wrong.
func TestCutStartMatchesEverySuffix(t *testing.T) {
	naive := func(line, value string) int {
		for size := min(len(value)-1, len(line)); size > 0; size-- {
			if strings.HasSuffix(line, value[:size]) {
				return size
			}
		}
		return 0
	}
	values := []string{"aaaaaaaab", "abababababab", "abcabcabd", "aabaabaaab", "x"}
	lines := []string{"", "a", "aaaaaaaaaaaaaaaa", "zzabababab", "abcabcabcab", "aabaabaabaabaa", "aabaabaaa", "q"}
	for _, value := range values {
		for _, line := range lines {
			if got, want := cutStart(line, value), naive(line, value); got != want {
				t.Fatalf("cutStart(%q, %q) = %d, want %d", line, value, got, want)
			}
		}
	}
}
