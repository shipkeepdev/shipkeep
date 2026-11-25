package logship

import "testing"

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
