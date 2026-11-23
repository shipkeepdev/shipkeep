package upgrade

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
)

func mustVersion(t *testing.T, text string) Version {
	t.Helper()
	version, err := ParseVersion(text)
	if err != nil {
		t.Fatalf("%q: %v", text, err)
	}
	return version
}

func TestParseVersionAcceptsReleaseVersionsOnly(t *testing.T) {
	for _, good := range []string{"0.1.0", "0.1.0-alpha.3", "1.2.3-rc.1", "10.20.30", "1.0.0-x-y.0"} {
		if _, err := ParseVersion(good); err != nil {
			t.Errorf("%q refused: %v", good, err)
		}
	}
	for _, bad := range []string{
		"", "v0.1.0", "0.1", "0.1.0.0", "01.1.0", "0.01.0", "0.1.0-", "0.1.0-alpha.01",
		"0.1.0+build.1", "0.1.0-alpha..1", " 0.1.0", "0.1.0\n", "0.1.0;rm -rf /", "0.1.0/../x",
		"0.1.0-%2e%2e", "０.1.0", "0.1.0-" + strings.Repeat("a", 64), "9999999999.0.0",
	} {
		if _, err := ParseVersion(bad); !errors.Is(err, ErrRefused) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestVersionsFollowSemanticVersioningPrecedence(t *testing.T) {
	ordered := []string{
		"0.1.0-alpha.3", "0.1.0-alpha.10", "0.1.0-beta.1", "0.1.0", "1.0.0-alpha", "1.0.0-alpha.1",
		"1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
		"1.0.1", "1.1.0", "2.0.0",
	}
	for i := range ordered {
		for j := range ordered {
			got := mustVersion(t, ordered[i]).Compare(mustVersion(t, ordered[j]))
			want := compareInts(i, j)
			if got != want {
				t.Errorf("%s vs %s: %d, want %d", ordered[i], ordered[j], got, want)
			}
		}
	}
}

func TestTheArchiveAddressIsBuiltFromTheVersionAlone(t *testing.T) {
	version := mustVersion(t, "0.1.0-alpha.3")
	got, err := ArchiveURL(version, "arm64")
	if err != nil || got != "https://github.com/shipkeepdev/shipkeep/releases/download/v0.1.0-alpha.3/shipkeep-agent_0.1.0-alpha.3_linux_arm64.tar.gz" {
		t.Fatalf("%q %v", got, err)
	}
	for _, arch := range []string{"", "386", "amd64/../x", "AMD64", "riscv64"} {
		if _, err := ArchiveURL(version, arch); !errors.Is(err, ErrRefused) {
			t.Errorf("architecture %q accepted", arch)
		}
	}
	if got := SignerIdentity(version); got != "https://github.com/shipkeepdev/shipkeep/.github/workflows/release.yml@refs/tags/v0.1.0-alpha.3" {
		t.Fatalf("identity %q", got)
	}
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// The real signatures of v0.1.0-alpha.3, made by release.yml for that tag.
func TestVerifyAcceptsWhatTheReleaseWorkflowSignedForThatTag(t *testing.T) {
	version := mustVersion(t, "0.1.0-alpha.3")
	for _, name := range []string{"shipkeep-control-plane_0.1.0-alpha.3.tar.gz", "checksums.txt"} {
		if err := Verify(fixture(t, name+".sigstore.json"), sha256.Sum256(fixture(t, name)), version); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestVerifyRefusesAnythingElse(t *testing.T) {
	version := mustVersion(t, "0.1.0-alpha.3")
	archive := fixture(t, "shipkeep-control-plane_0.1.0-alpha.3.tar.gz")
	bundleJSON := fixture(t, "shipkeep-control-plane_0.1.0-alpha.3.tar.gz.sigstore.json")
	changed := bytes.Clone(archive)
	changed[len(changed)/2] ^= 1
	forged := changedSignature(t, bundleJSON)
	cases := map[string]struct {
		bundle  []byte
		digest  [32]byte
		version Version
	}{
		"a changed archive":              {bundleJSON, sha256.Sum256(changed), version},
		"another release file's bundle":  {fixture(t, "checksums.txt.sigstore.json"), sha256.Sum256(archive), version},
		"another tag":                    {bundleJSON, sha256.Sum256(archive), mustVersion(t, "0.1.0-alpha.4")},
		"an older tag":                   {bundleJSON, sha256.Sum256(archive), mustVersion(t, "0.1.0-alpha.2")},
		"a changed signature":            {forged, sha256.Sum256(archive), version},
		"no bundle":                      {nil, sha256.Sum256(archive), version},
		"a bundle that is not one":       {[]byte(`{"mediaType":"x"}`), sha256.Sum256(archive), version},
		"a bundle larger than the bound": {bytes.Repeat([]byte(" "), maxBundleBytes+1), sha256.Sum256(archive), version},
	}
	for name, c := range cases {
		if err := Verify(c.bundle, c.digest, c.version); !errors.Is(err, ErrRefused) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}

// changedSignature returns the bundle with one bit of its signature flipped.
func changedSignature(t *testing.T, bundleJSON []byte) []byte {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(bundleJSON, &document); err != nil {
		t.Fatal(err)
	}
	message, _ := document["messageSignature"].(map[string]any)
	encoded, _ := message["signature"].(string)
	signature, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(signature) == 0 {
		t.Fatalf("the bundle fixture has no signature to change: %v", err)
	}
	signature[len(signature)/2] ^= 1
	message["signature"] = base64.StdEncoding.EncodeToString(signature)
	forged, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return forged
}

// fakeGitHub answers in place of the network.
type fakeGitHub struct {
	status int
	body   []byte
	length int64
	seen   []string
}

func (f *fakeGitHub) RoundTrip(request *http.Request) (*http.Response, error) {
	f.seen = append(f.seen, request.URL.String())
	return &http.Response{
		StatusCode:    f.status,
		Body:          io.NopCloser(bytes.NewReader(f.body)),
		ContentLength: f.length,
		Request:       request,
	}, nil
}

func TestDownloadGoesToGitHubOverHTTPSOnly(t *testing.T) {
	github := &fakeGitHub{status: http.StatusOK, body: []byte("archive"), length: -1}
	client := &http.Client{Transport: github}
	ctx := context.Background()
	address := "https://github.com/shipkeepdev/shipkeep/releases/download/v0.1.0/shipkeep-agent_0.1.0_linux_amd64.tar.gz"
	if data, err := Download(ctx, client, address, 1024); err != nil || string(data) != "archive" {
		t.Fatalf("%q %v", data, err)
	}
	for _, bad := range []string{
		"http://github.com/x", "https://evil.example.com/x", "https://github.com.evil.example.com/x",
		"https://user:pass@github.com/x", "https://github.com:8443/x", "file:///etc/passwd",
		"https://169.254.169.254/latest/meta-data", "ftp://github.com/x", "://",
	} {
		if _, err := Download(ctx, client, bad, 1024); !errors.Is(err, ErrRefused) {
			t.Errorf("%q accepted", bad)
		}
	}
	if len(github.seen) != 1 {
		t.Fatalf("refused addresses were requested: %v", github.seen)
	}
	// Larger than the bound, announced or not; and an error status.
	for _, answer := range []*fakeGitHub{
		{status: http.StatusOK, body: bytes.Repeat([]byte("a"), 2048), length: 2048},
		{status: http.StatusOK, body: bytes.Repeat([]byte("a"), 2048), length: -1},
	} {
		if _, err := Download(ctx, &http.Client{Transport: answer}, address, 1024); !errors.Is(err, ErrRefused) {
			t.Errorf("an oversized download accepted: %v", err)
		}
	}
	if _, err := Download(ctx, &http.Client{Transport: &fakeGitHub{status: http.StatusNotFound, length: -1}}, address, 1024); err == nil {
		t.Error("a 404 accepted")
	}
}

func TestRedirectsStayOnGitHubsReleaseHosts(t *testing.T) {
	check := Client().CheckRedirect
	to := func(address string) *http.Request {
		parsed, err := url.Parse(address)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Request{URL: parsed}
	}
	for _, good := range []string{"https://objects.githubusercontent.com/x", "https://release-assets.githubusercontent.com/x"} {
		if err := check(to(good), []*http.Request{to("https://github.com/x")}); err != nil {
			t.Errorf("%s refused: %v", good, err)
		}
	}
	for _, bad := range []string{"http://objects.githubusercontent.com/x", "https://evil.example.com/x", "https://127.0.0.1/x"} {
		if err := check(to(bad), []*http.Request{to("https://github.com/x")}); !errors.Is(err, ErrRefused) {
			t.Errorf("redirect to %s accepted", bad)
		}
	}
	via := make([]*http.Request, maxRedirects)
	if err := check(to("https://github.com/x"), via); !errors.Is(err, ErrRefused) {
		t.Error("a sixth redirect accepted")
	}
}

type entry struct {
	name     string
	typeflag byte
	body     string
	size     int64
	link     string
}

func archiveOf(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var out bytes.Buffer
	zipped := gzip.NewWriter(&out)
	writer := tar.NewWriter(zipped)
	for _, e := range entries {
		size := e.size
		if size == 0 {
			size = int64(len(e.body))
		}
		typeflag := e.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		if err := writer.WriteHeader(&tar.Header{Name: e.name, Typeflag: typeflag, Size: size, Mode: 0o755, Linkname: e.link}); err != nil {
			t.Fatal(err)
		}
		if typeflag == tar.TypeReg {
			if _, err := writer.Write([]byte(e.body)); err != nil && size == int64(len(e.body)) {
				t.Fatal(err)
			}
		}
	}
	// A short entry leaves the writer in error; the archive is cut there on purpose.
	_ = writer.Close()
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestExtractAgentTakesTheOneBinaryAtTheRoot(t *testing.T) {
	for _, archive := range [][]byte{
		archiveOf(t, entry{name: "LICENSE", body: "Apache"}, entry{name: "shipkeep-agent", body: "ELF"}, entry{name: "NOTICE", body: "n"}),
		archiveOf(t, entry{name: "./shipkeep-agent", body: "ELF"}),
	} {
		if binary, err := ExtractAgent(archive); err != nil || string(binary) != "ELF" {
			t.Fatalf("%q %v", binary, err)
		}
	}
}

func TestExtractAgentRefusesMaliciousArchives(t *testing.T) {
	many := make([]entry, maxEntries+1, maxEntries+2)
	for i := range many {
		many[i] = entry{name: "f", body: "x"}
	}
	cases := map[string][]byte{
		"not gzip":                       []byte("PK\x03\x04 zip"),
		"no agent":                       archiveOf(t, entry{name: "LICENSE", body: "x"}),
		"the agent twice":                archiveOf(t, entry{name: "shipkeep-agent", body: "a"}, entry{name: "shipkeep-agent", body: "b"}),
		"the agent as a symlink":         archiveOf(t, entry{name: "shipkeep-agent", typeflag: tar.TypeSymlink, link: "/bin/sh"}),
		"the agent as a hard link":       archiveOf(t, entry{name: "shipkeep-agent", typeflag: tar.TypeLink, link: "LICENSE"}),
		"the agent as a directory":       archiveOf(t, entry{name: "shipkeep-agent", typeflag: tar.TypeDir}),
		"an entry that climbs out":       archiveOf(t, entry{name: "../shipkeep-agent", body: "ELF"}),
		"an entry that climbs further":   archiveOf(t, entry{name: "x/../../etc/cron.d/evil", body: "*"}),
		"an absolute entry":              archiveOf(t, entry{name: "/usr/local/bin/shipkeep-agent", body: "ELF"}),
		"an empty agent":                 archiveOf(t, entry{name: "shipkeep-agent", body: ""}),
		"an agent larger than the bound": archiveOf(t, entry{name: "shipkeep-agent", body: "x", size: MaxBinaryBytes + 1}),
		"an agent cut short":             archiveOf(t, entry{name: "shipkeep-agent", body: "ELF", size: 1000}),
		"too many entries":               archiveOf(t, append(many, entry{name: "shipkeep-agent", body: "ELF"})...),
	}
	for name, archive := range cases {
		if binary, err := ExtractAgent(archive); !errors.Is(err, ErrRefused) {
			t.Errorf("%s accepted: %q %v", name, binary, err)
		}
	}
}
