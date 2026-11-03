package buildinfo

import "testing"

func TestStringContainsAllFields(t *testing.T) {
	t.Parallel()

	got := String("shipkeep-agent")
	for _, want := range []string{"shipkeep-agent", Version, Commit, Date} {
		if !contains(got, want) {
			t.Fatalf("String() = %q, missing %q", got, want)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
