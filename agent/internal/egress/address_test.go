package egress

import (
	"net/netip"
	"os"
	"regexp"
	"slices"
	"testing"
)

func TestPublic(t *testing.T) {
	for address, want := range map[string]bool{
		"8.8.8.8":                     true,
		"1.1.1.1":                     true,
		"2606:4700:4700::1111":        true,
		"::ffff:8.8.8.8":              true,
		"0.0.0.0":                     false,
		"127.0.0.1":                   false,
		"127.255.255.254":             false,
		"10.1.2.3":                    false,
		"172.16.0.1":                  false,
		"172.31.255.255":              false,
		"192.168.208.3":               false,
		"169.254.169.254":             false, // cloud metadata
		"100.64.0.1":                  false,
		"198.18.0.1":                  false,
		"192.0.2.1":                   false,
		"224.0.0.1":                   false,
		"255.255.255.255":             false,
		"::":                          false,
		"::1":                         false,
		"::ffff:127.0.0.1":            false,
		"::ffff:7f00:1":               false, // mapped loopback written in hex
		"::ffff:169.254.169.254":      false,
		"64:ff9b::a9fe:a9fe":          false, // NAT64 form of the metadata address
		"64:ff9b:1::1":                false,
		"fc00::1":                     false,
		"fd12:3456::1":                false,
		"fe80::1":                     false,
		"ff02::1":                     false,
		"2001:db8::1":                 false,
		"2002:7f00:1::":               false, // 6to4 of loopback
		"fe80::1%eth0":                false,
		"2606:4700:4700::1111%eth0":   false, // a zone never makes an address public
		"::ffff:0:0":                  false,
		"0000:0000:0000:0000::0001":   false,
		"2001:4860:4860::8888":        true,
		"::ffff:2001:4860:4860::8888": false, // not an address
	} {
		parsed, err := netip.ParseAddr(address)
		got := err == nil && Public(parsed)
		if got != want {
			t.Errorf("Public(%q) = %v, want %v", address, got, want)
		}
	}
	if Public(netip.Addr{}) {
		t.Error("the zero address is public")
	}
}

// The node refuses exactly what the control plane refuses.
func TestBlockedRangesMatchTheControlPlane(t *testing.T) {
	source, err := os.ReadFile("../../../apps/api/src/platform/net/public-address.ts")
	if err != nil {
		t.Fatal(err)
	}
	matches := regexp.MustCompile(`\['([0-9a-f:.]+)', (\d+)\]`).FindAllSubmatch(source, -1)
	theirs := make([]string, 0, len(matches))
	for _, match := range matches {
		theirs = append(theirs, netip.MustParsePrefix(string(match[1])+"/"+string(match[2])).String())
	}
	ours := make([]string, 0, len(blocked))
	for _, prefix := range blocked {
		ours = append(ours, prefix.String())
	}
	slices.Sort(theirs)
	slices.Sort(ours)
	if len(theirs) < 20 || !slices.Equal(theirs, ours) {
		t.Fatalf("blocked ranges differ:\ncontrol plane %v\nagent         %v", theirs, ours)
	}
}
