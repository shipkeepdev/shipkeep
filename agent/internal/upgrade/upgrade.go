// Package upgrade is what an agent checks before it replaces its own binary (ADR 0028): the
// version it is asked for, where that release lives, and that Shipkeep's release workflow signed
// the archive it downloaded. Nothing here trusts the control plane for more than a version
// number: the address is built here, and the signature is verified offline against Sigstore's
// trusted root, embedded at build time.
package upgrade

//go:generate go run ./gen

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ErrRefused wraps every refusal of this package: the input is not an acceptable release.
var ErrRefused = errors.New("upgrade refused")

// Repository is where releases are published, and what signs them.
const (
	releases       = "https://github.com/shipkeepdev/shipkeep/releases/download/"
	identityPrefix = "https://github.com/shipkeepdev/shipkeep/.github/workflows/release.yml@refs/tags/v"
	// Issuer is GitHub's OIDC issuer, which vouches for the workflow's identity.
	Issuer = "https://token.actions.githubusercontent.com"
)

// A version is semantic versioning without build metadata: MAJOR.MINOR.PATCH, then an optional
// prerelease of dot-separated identifiers. Numbers have no leading zero.
var versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)

// Version is a parsed release version.
type Version struct {
	Major, Minor, Patch int
	pre                 []string
	text                string
}

// ParseVersion reads a release version, as the release tag names it without its `v`.
func ParseVersion(text string) (Version, error) {
	if len(text) > 64 {
		return Version{}, fmt.Errorf("%w: a version is at most 64 characters", ErrRefused)
	}
	parts := versionPattern.FindStringSubmatch(text)
	if parts == nil {
		return Version{}, fmt.Errorf("%w: not a release version", ErrRefused)
	}
	version := Version{text: text}
	for index, target := range []*int{&version.Major, &version.Minor, &version.Patch} {
		number, err := strconv.Atoi(parts[index+1])
		if err != nil {
			return Version{}, fmt.Errorf("%w: not a release version", ErrRefused)
		}
		*target = number
	}
	if parts[4] != "" {
		version.pre = strings.Split(parts[4], ".")
		for _, identifier := range version.pre {
			if len(identifier) > 1 && identifier[0] == '0' && numeric(identifier) {
				return Version{}, fmt.Errorf("%w: a numeric prerelease part has no leading zero", ErrRefused)
			}
		}
	}
	return version, nil
}

func (v Version) String() string { return v.text }

// Compare orders two versions by semantic versioning precedence: negative when v comes first.
func (v Version) Compare(w Version) int {
	for _, pair := range [][2]int{{v.Major, w.Major}, {v.Minor, w.Minor}, {v.Patch, w.Patch}} {
		if pair[0] != pair[1] {
			return compareInts(pair[0], pair[1])
		}
	}
	// A release comes after its prereleases.
	switch {
	case len(v.pre) == 0 && len(w.pre) == 0:
		return 0
	case len(v.pre) == 0:
		return 1
	case len(w.pre) == 0:
		return -1
	}
	for index := 0; index < len(v.pre) && index < len(w.pre); index++ {
		a, b := v.pre[index], w.pre[index]
		if a == b {
			continue
		}
		aNumber, bNumber := numeric(a), numeric(b)
		switch {
		case aNumber && bNumber:
			x, _ := strconv.Atoi(a)
			y, _ := strconv.Atoi(b)
			return compareInts(x, y)
		case aNumber:
			return -1
		case bNumber:
			return 1
		default:
			return strings.Compare(a, b)
		}
	}
	return compareInts(len(v.pre), len(w.pre))
}

func compareInts(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func numeric(identifier string) bool {
	if identifier == "" || len(identifier) > 9 {
		return false
	}
	for _, r := range identifier {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Architectures are the ones releases carry the agent for.
var architectures = map[string]bool{"amd64": true, "arm64": true}

// ArchiveName is the name of the agent archive of a release for an architecture.
func ArchiveName(version Version, arch string) (string, error) {
	if !architectures[arch] {
		return "", fmt.Errorf("%w: no agent is released for %q", ErrRefused, arch)
	}
	return "shipkeep-agent_" + version.text + "_linux_" + arch + ".tar.gz", nil
}

// ArchiveURL is where that archive is published. It is built here, from the version alone: the
// control plane names a version, never an address.
func ArchiveURL(version Version, arch string) (string, error) {
	name, err := ArchiveName(version, arch)
	if err != nil {
		return "", err
	}
	return releases + "v" + version.text + "/" + name, nil
}

// SignerIdentity is the certificate identity a release's signature must carry: the release
// workflow, run for that version's tag.
func SignerIdentity(version Version) string {
	return identityPrefix + version.text
}
