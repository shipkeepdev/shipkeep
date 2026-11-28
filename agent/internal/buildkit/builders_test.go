package buildkit

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/moby/buildkit/client/llb"
	"github.com/moby/buildkit/solver/pb"
)

const testTarget = "cp.example.com/0190f5a8-7b1c-7e2d-8f3a-0000000000aa/0190f5a8-7b1c-7e2d-8f3a-0000000000ab:7"

func testRequest(kind Kind) Request {
	return Request{
		Kind:       kind,
		Repository: "https://github.com/acme-corp/billing.git",
		Commit:     "0123456789abcdef0123456789abcdef01234567",
		Context:    "services/api",
		Args:       map[string]string{"NODE_ENV": "production", "FLAG": "--out=/etc"},
		Target:     testTarget,
		// Client.Build sets it from the agent's key.
		CacheNamespace: "sk-test",
	}
}

// ops are the operations of a state's definition.
func ops(t *testing.T, state llb.State) []*pb.Op {
	t.Helper()
	definition, err := state.Marshal(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	all := make([]*pb.Op, 0, len(definition.Def))
	for _, raw := range definition.Def {
		var op pb.Op
		if err := op.UnmarshalVT(raw); err != nil {
			t.Fatal(err)
		}
		all = append(all, &op)
	}
	return all
}

func execs(all []*pb.Op) []*pb.ExecOp {
	var found []*pb.ExecOp
	for _, op := range all {
		if exec := op.GetExec(); exec != nil {
			found = append(found, exec)
		}
	}
	return found
}

func sources(all []*pb.Op) []*pb.SourceOp {
	var found []*pb.SourceOp
	for _, op := range all {
		if source := op.GetSource(); source != nil {
			found = append(found, source)
		}
	}
	return found
}

// The repository is mounted read-only at /src: a builder that writes it writes nothing that ships.
func readOnlySource(t *testing.T, exec *pb.ExecOp) {
	t.Helper()
	for _, mount := range exec.GetMounts() {
		if mount.GetDest() == "/src" {
			if !mount.GetReadonly() {
				t.Fatal("the repository is mounted writable")
			}
			return
		}
	}
	t.Fatal("the repository is not mounted")
}

// ADR 0030: Nixpacks comes from its release archive, checked against its pinned SHA-256, and runs
// alone: no network, the repository read-only, each argument one argv entry.
func TestNixpacksRunsThePinnedReleaseWithoutNetwork(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64"} {
		state, err := NixpacksOutput(testRequest(Nixpacks), llb.Scratch(), arch)
		if err != nil {
			t.Fatal(err)
		}
		all := ops(t, state)
		var archive *pb.SourceOp
		for _, source := range sources(all) {
			if strings.HasPrefix(source.GetIdentifier(), "https://") {
				archive = source
			}
		}
		release := nixpacksRelease[arch]
		if archive == nil || archive.GetIdentifier() != release.url || archive.GetAttrs()[pb.AttrHTTPChecksum] != release.sha256.String() {
			t.Fatalf("%s: archive = %+v", arch, archive)
		}
		run := execs(all)
		if len(run) != 1 {
			t.Fatalf("%s: %d runs", arch, len(run))
		}
		want := []string{"/nixpacks", "build", "/src", "--out", "/out", "--cache-key", "sk-test",
			"--env", "FLAG=--out=/etc", "--env", "NODE_ENV=production"}
		if !slices.Equal(run[0].GetMeta().GetArgs(), want) {
			t.Fatalf("%s: args = %q", arch, run[0].GetMeta().GetArgs())
		}
		if run[0].GetNetwork() != pb.NetMode_NONE {
			t.Fatalf("%s: network = %v", arch, run[0].GetNetwork())
		}
		readOnlySource(t, run[0])
	}
	if _, err := NixpacksOutput(testRequest(Nixpacks), llb.Scratch(), "riscv64"); err == nil {
		t.Fatal("an architecture without a release was built")
	}
}

// ADR 0030: Railpack prepares in its own image, pinned by digest, the repository read-only.
func TestRailpackPreparesInItsPinnedImage(t *testing.T) {
	all := ops(t, RailpackPrepared(testRequest(Railpack), llb.Scratch()))
	images := 0
	for _, source := range sources(all) {
		if strings.HasPrefix(source.GetIdentifier(), "docker-image://") {
			images++
			if source.GetIdentifier() != "docker-image://"+RailpackFrontend {
				t.Fatalf("image = %s", source.GetIdentifier())
			}
		}
	}
	if images != 1 || !strings.Contains(RailpackFrontend, "@sha256:") {
		t.Fatalf("%d images, %s", images, RailpackFrontend)
	}
	run := execs(all)
	if len(run) != 1 {
		t.Fatalf("%d runs", len(run))
	}
	want := []string{"/railpack", "prepare", "/src", "--plan-out", "/plan/railpack-plan.json", "--info-out", "/plan/railpack-info.json",
		"--env", "FLAG=--out=/etc", "--env", "NODE_ENV=production"}
	if !slices.Equal(run[0].GetMeta().GetArgs(), want) {
		t.Fatalf("args = %q", run[0].GetMeta().GetArgs())
	}
	readOnlySource(t, run[0])
}

// The frontend is the same pinned image, its cache mounts are the application's own, and a new
// argument value rebuilds.
func TestRailpackBuildsWithItsPinnedFrontend(t *testing.T) {
	options := RailpackOptions(testRequest(Railpack))
	if options.Frontend != "gateway.v0" || options.FrontendAttrs["source"] != RailpackFrontend {
		t.Fatalf("options = %+v", options)
	}
	if options.FrontendAttrs["build-arg:cache-key"] != "sk-test" || len(options.Exports) != 1 ||
		options.Exports[0].Attrs["name"] != testTarget || options.Exports[0].Attrs["push"] != "true" {
		t.Fatalf("options = %+v", options)
	}
	changed := testRequest(Railpack)
	changed.Args = map[string]string{"NODE_ENV": "staging", "FLAG": "--out=/etc"}
	if RailpackOptions(changed).FrontendAttrs["build-arg:secrets-hash"] == options.FrontendAttrs["build-arg:secrets-hash"] {
		t.Fatal("a new argument value keeps the cache")
	}
	// The arguments are build secrets under their names, as Railpack reads them; never in attrs.
	for name, value := range options.FrontendAttrs {
		if strings.Contains(value, "production") || strings.Contains(name, "NODE_ENV") {
			t.Fatalf("an argument is in the frontend's options: %s=%s", name, value)
		}
	}
	if string(argSecrets(changed.Args)["NODE_ENV"]) != "staging" {
		t.Fatal("the arguments are not served")
	}
}

// A cache namespace is the application's own, and only this agent's key names it: a build that
// knows another application's identifiers cannot name its caches.
func TestCacheNamespacesAreOneApplicationsOwn(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	other := strings.Replace(testTarget, "0000000000ab", "0000000000ac", 1)
	if CacheNamespace(key, testTarget) != CacheNamespace(key, strings.TrimSuffix(testTarget, ":7")+":8") {
		t.Fatal("two releases of one application have different caches")
	}
	if CacheNamespace(key, testTarget) == CacheNamespace(key, other) ||
		CacheNamespace(key, "cp.example.com:5000/a/b:1") == CacheNamespace(key, "cp.example.com:5000/a/c:1") {
		t.Fatal("two applications share a cache")
	}
	if CacheNamespace(key, testTarget) == CacheNamespace([]byte(strings.Repeat("o", 32)), testTarget) {
		t.Fatal("the namespace does not depend on the agent's key")
	}
	unkeyed := sha256.Sum256([]byte(strings.TrimSuffix(testTarget, ":7")))
	if strings.Contains(CacheNamespace(key, testTarget), hex.EncodeToString(unkeyed[:8])) {
		t.Fatal("the namespace is the repository's plain hash")
	}
}

// The key is made once, readable by the agent alone, and kept across restarts; a damaged one is
// replaced.
func TestTheCacheKeyIsTheAgentsOwn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "build-cache.key")
	first, err := LoadCacheSecret(path)
	if err != nil || len(first) != 32 {
		t.Fatalf("key = %d bytes, %v", len(first), err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file = %v, %v", info, err)
	}
	again, err := LoadCacheSecret(path)
	if err != nil || !bytes.Equal(first, again) {
		t.Fatal("the key changed across loads")
	}
	if err := os.WriteFile(path, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	replaced, err := LoadCacheSecret(path)
	if err != nil || len(replaced) != 32 || bytes.Equal(replaced, first) {
		t.Fatalf("a damaged key was kept: %d bytes, %v", len(replaced), err)
	}
}

// Every build type keeps its cache mounts in the application's namespace.
func TestDockerfileCachesAreNamespaced(t *testing.T) {
	options := SolveOptions(testRequest(Dockerfile), "token", "header")
	if options.FrontendAttrs["build-arg:BUILDKIT_CACHE_MOUNT_NS"] != "sk-test" {
		t.Fatalf("attrs = %v", options.FrontendAttrs)
	}
}

// What the repository keeps under `.nixpacks` is removed before Nixpacks' files go on top.
func TestNixpacksReplacesTheRepositorysNixpacksDirectory(t *testing.T) {
	removed := false
	for _, op := range ops(t, NixpacksContext(llb.Scratch().File(llb.Mkdir("/app", 0o755)), llb.Scratch())) {
		for _, action := range op.GetFile().GetActions() {
			if rm := action.GetRm(); rm != nil && rm.GetPath() == "/.nixpacks" && rm.GetAllowNotFound() {
				removed = true
			}
		}
	}
	if !removed {
		t.Fatal("the repository's .nixpacks is kept")
	}
}

// Before anything reaches BuildKit: a build without the agent's key is refused, and whatever an
// interrupted build left on disk is removed. The directory itself stays: on a server, the
// installer made it on the builds' filesystem, where the agent cannot make it again (#548).
func TestABuildStartsFromAnEmptyWorkDirectory(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "builds")
	left := filepath.Join(work, "railpack-123", "src")
	if err := os.MkdirAll(left, 0o700); err != nil {
		t.Fatal(err)
	}
	// A link an interrupted build left goes, and what it names stays.
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "kept"), []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(work, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, ".hidden"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := (Client{Address: "unix:///nonexistent/buildkitd.sock", WorkDir: work}).Build(ctx, testRequest(Dockerfile), func(string) {}); err == nil {
		t.Fatal("a build without a cache key ran")
	}
	keyed := Client{Address: "unix:///nonexistent/buildkitd.sock", WorkDir: work, CacheSecret: []byte(strings.Repeat("k", 32))}
	if _, err := keyed.Build(ctx, testRequest(Dockerfile), func(string) {}); err == nil {
		t.Fatal("a build without a daemon succeeded")
	}
	entries, err := os.ReadDir(work)
	if err != nil {
		t.Fatalf("the work directory is gone: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("the interrupted build's files are still there: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(outside, "kept")); err != nil {
		t.Fatalf("emptying the work directory followed a link: %v", err)
	}
	// A missing directory is an empty one: the build goes on and Railpack's step makes it.
	if _, err := (Client{Address: "unix:///nonexistent/buildkitd.sock", WorkDir: filepath.Join(root, "missing"), CacheSecret: []byte(strings.Repeat("k", 32))}).Build(ctx, testRequest(Dockerfile), func(string) {}); err == nil || strings.Contains(err.Error(), "build directory") {
		t.Fatalf("a missing work directory: %v", err)
	}
}

// What Nixpacks 1.41 writes in `.nixpacks/build.sh` for a Node application.
const nixpacksScriptSample = "docker build /out -f /out/.nixpacks/Dockerfile -t 654909b5-7c9c-4d0d-a817-2e2cb87a651f " +
	"--build-arg CI=true --build-arg GREETING=hi --build-arg NIXPACKS_METADATA=node --build-arg NODE_ENV=production " +
	"--build-arg NPM_CONFIG_PRODUCTION=false"

func TestNixpacksBuildArgsAreReadFromItsScript(t *testing.T) {
	got := NixpacksBuildArgs([]byte(nixpacksScriptSample))
	want := map[string]string{"CI": "true", "GREETING": "hi", "NIXPACKS_METADATA": "node", "NODE_ENV": "production", "NPM_CONFIG_PRODUCTION": "false"}
	if len(got) != len(want) {
		t.Fatalf("args = %v", got)
	}
	for name, value := range want {
		if got[name] != value {
			t.Fatalf("args = %v", got)
		}
	}
}

// A repository chooses the variables Nixpacks writes: nothing in them reaches beyond build args.
func TestNixpacksBuildArgsRefuseWhatIsNotAnArgument(t *testing.T) {
	for name, script := range map[string]string{
		"BuildKit's own":     "--build-arg BUILDKIT_SYNTAX=evil/frontend --build-arg buildkit_context_keep_git_dir=1",
		"not a name":         "--build-arg A-B=1 --build-arg 1A=2 --build-arg =3 --build-arg A.B=4",
		"no value":           "--build-arg NOVALUE --build-arg",
		"oversized value":    "--build-arg BIG=" + strings.Repeat("x", 4097),
		"oversized name":     "--build-arg " + strings.Repeat("A", 129) + "=1",
		"invalid UTF-8":      "--build-arg A=\xff",
		"oversized script":   "--build-arg A=1 " + strings.Repeat(" ", 64<<10),
		"other flags":        "--secret id=x,src=/etc/shadow --build-context x=/ --output type=local,dest=/",
		"a flag as an value": "--build-arg --build-arg",
	} {
		if got := NixpacksBuildArgs([]byte(script)); len(got) != 0 {
			t.Fatalf("%s: args = %v", name, got)
		}
	}
	// A value with a space is cut there; the rest is not an argument.
	got := NixpacksBuildArgs([]byte("--build-arg GREETING=hello world --build-arg B=2"))
	if got["GREETING"] != "hello" || got["B"] != "2" || len(got) != 2 {
		t.Fatalf("args = %v", got)
	}
	many := strings.Repeat("--build-arg A=1 ", 10)
	for i := range 300 {
		many += "--build-arg V" + strings.Repeat("X", i%5) + string(rune('A'+i%26)) + "=1 "
	}
	if got := NixpacksBuildArgs([]byte(many)); len(got) > maxNixpacksArgs {
		t.Fatalf("%d args", len(got))
	}
}
