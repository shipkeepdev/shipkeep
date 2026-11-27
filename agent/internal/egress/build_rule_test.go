package egress

import (
	"net/netip"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The installer's build rule (ADR 0030, deploy/install.sh) refuses what the proxy refuses, and
// IPv4-mapped addresses, which the proxy judges by their IPv4 part.
func TestTheBuildRuleRefusesTheProxysRanges(t *testing.T) {
	script, err := os.ReadFile("../../../deploy/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	read := func(name string) []netip.Prefix {
		match := regexp.MustCompile(`(?m)^` + name + `='([^']*)'$`).FindSubmatch(script)
		if match == nil {
			t.Fatalf("%s is not in deploy/install.sh", name)
		}
		texts := strings.Split(string(match[1]), ", ")
		prefixes := make([]netip.Prefix, 0, len(texts))
		for _, text := range texts {
			prefix, err := netip.ParsePrefix(text)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			prefixes = append(prefixes, prefix)
		}
		return prefixes
	}
	got := append(read("build_blocked_ipv4"), read("build_blocked_ipv6")...)
	want := append(slices.Clone(blocked), netip.MustParsePrefix("::ffff:0:0/96"))
	sort := func(prefixes []netip.Prefix) []string {
		out := make([]string, len(prefixes))
		for i, p := range prefixes {
			out[i] = p.String()
		}
		slices.Sort(out)
		return out
	}
	if !slices.Equal(sort(got), sort(want)) {
		t.Fatalf("build rule %v, proxy %v", sort(got), sort(want))
	}
}
