package buildkit

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/moby/buildkit/client"
	"github.com/moby/buildkit/client/llb"
	gateway "github.com/moby/buildkit/frontend/gateway/client"
	"github.com/moby/buildkit/session"
	"github.com/moby/buildkit/session/secrets/secretsprovider"
	"github.com/moby/buildkit/solver/pb"
	digest "github.com/opencontainers/go-digest"
	"github.com/tonistiigi/fsutil"
)

// RailpackFrontend is Railpack's frontend image (MIT), v0.43.0, pinned by its index digest. The
// same image runs `railpack prepare`, which writes the plan its frontend builds (ADR 0030).
const RailpackFrontend = "ghcr.io/railwayapp/railpack-frontend:v0.43.0@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc"

// nixpacksRelease is the Nixpacks release (MIT) a build fetches, each architecture's archive
// pinned by the SHA-256 GitHub publishes for it. The binary is static and runs alone.
var nixpacksRelease = map[string]struct {
	url    string
	sha256 digest.Digest
}{
	"amd64": {
		url:    "https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz",
		sha256: "sha256:0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6",
	},
	"arm64": {
		url:    "https://github.com/railwayapp/nixpacks/releases/download/v1.41.0/nixpacks-v1.41.0-aarch64-unknown-linux-musl.tar.gz",
		sha256: "sha256:912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39",
	},
}

const (
	railpackPlan = "railpack-plan.json"
	// The script Nixpacks writes with its Dockerfile: the `docker build` it would have run.
	nixpacksScript    = ".nixpacks/build.sh"
	nixpacksFile      = ".nixpacks/Dockerfile"
	maxNixpacksScript = 64 << 10
	maxNixpacksArgs   = 200
	maxNixpacksValue  = 4096
	cacheSecretBytes  = 32
)

// A build argument Nixpacks passes: an environment variable's name.
var nixpacksArgName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// CacheNamespace separates one application's cache mounts from another's on the same builder:
// the repository its image is pushed to, without its tag, keyed with a secret only this agent
// holds, so that no build can name another application's caches.
func CacheNamespace(secret []byte, target string) string {
	repository := target
	if index := strings.LastIndexByte(target, ':'); index > strings.LastIndexByte(target, '/') {
		repository = target[:index]
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(repository))
	return "sk-" + hex.EncodeToString(mac.Sum(nil)[:12])
}

// LoadCacheSecret reads the agent's build cache key from path, or writes a new random one there,
// readable by the agent alone. A key of the wrong length is replaced.
func LoadCacheSecret(path string) ([]byte, error) {
	key, err := os.ReadFile(path) //nolint:gosec // the agent's own state directory
	if err == nil && len(key) == cacheSecretBytes {
		return key, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("read the build cache key: %w", err)
	}
	key = make([]byte, cacheSecretBytes)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("build cache key: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, key, 0o600); err != nil {
		return nil, fmt.Errorf("write the build cache key: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return nil, fmt.Errorf("write the build cache key: %w", err)
	}
	return key, nil
}

// sortedNames is the build arguments' names in order, so that a build's definition is stable.
func sortedNames(args map[string]string) []string {
	names := make([]string, 0, len(args))
	for name := range args {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// envFlags passes the build arguments to Railpack or Nixpacks, each as one argument of its own:
// a name checked by the action and its value, never read by a shell.
func envFlags(args map[string]string) []string {
	flags := make([]string, 0, 2*len(args))
	for _, name := range sortedNames(args) {
		flags = append(flags, "--env", name+"="+args[name])
	}
	return flags
}

// RailpackPrepared is the repository under `src/` and the plan `railpack prepare` wrote for it
// under `plan/`. Railpack runs in its own pinned image, the repository mounted read-only.
func RailpackPrepared(request Request, source llb.State) llb.State {
	args := append([]string{
		"/railpack", "prepare", "/src",
		"--plan-out", "/plan/" + railpackPlan,
		"--info-out", "/plan/railpack-info.json",
	}, envFlags(request.Args)...)
	run := llb.Image(RailpackFrontend).Run(
		llb.Args(args),
		llb.AddMount("/src", source, llb.Readonly),
		llb.WithCustomName("railpack prepare"),
	)
	plan := run.AddMount("/plan", llb.Scratch())
	contents := &llb.CopyInfo{CopyDirContentsOnly: true, CreateDestPath: true}
	return llb.Scratch().
		File(llb.Copy(source, "/", "/src/", contents), llb.WithCustomName("copy the repository")).
		File(llb.Copy(plan, "/", "/plan/", contents), llb.WithCustomName("copy the plan"))
}

// RailpackOptions builds the plan with Railpack's frontend and pushes the image. The frontend reads
// the repository and the plan from this build's session, which serves them from the server's disk
// (ADR 0030): it takes no other source.
func RailpackOptions(request Request) client.SolveOpt {
	values := sha256.New()
	for _, name := range sortedNames(request.Args) {
		values.Write([]byte(name + "=" + request.Args[name] + "\x00"))
	}
	return client.SolveOpt{
		Frontend: "gateway.v0",
		FrontendAttrs: map[string]string{
			"source": RailpackFrontend,
			// The cache mounts of one application are its own, and a new argument value rebuilds.
			"build-arg:cache-key":    request.CacheNamespace,
			"build-arg:secrets-hash": hex.EncodeToString(values.Sum(nil)),
		},
		Exports: pushTo(request.Target),
	}
}

// railpack writes the repository and Railpack's plan to a directory of WorkDir, then builds them
// with Railpack's frontend, which only reads local directories, and removes them.
func (c Client) railpack(ctx context.Context, daemon *client.Client, request Request, source llb.State, fetch []session.Attachable, output *printer) (*client.SolveResponse, error) {
	if c.WorkDir == "" {
		return nil, errors.New("railpack builds need a work directory")
	}
	// Build emptied WorkDir already: what an interrupted build left is gone.
	if err := os.MkdirAll(c.WorkDir, 0o700); err != nil {
		return nil, fmt.Errorf("build directory: %w", err)
	}
	dir, err := os.MkdirTemp(c.WorkDir, "railpack-")
	if err != nil {
		return nil, fmt.Errorf("build directory: %w", err)
	}
	defer os.RemoveAll(dir) //nolint:errcheck // the next Railpack build clears what is left
	definition, err := RailpackPrepared(request, source).Marshal(ctx)
	if err != nil {
		return nil, fmt.Errorf("railpack prepare: %w", err)
	}
	prepare := client.SolveOpt{
		Exports: []client.ExportEntry{{Type: client.ExporterLocal, OutputDir: dir}},
		Session: fetch,
	}
	if _, err := solve(output, func(progress chan *client.SolveStatus) (*client.SolveResponse, error) {
		return daemon.Solve(ctx, definition, prepare, progress)
	}); err != nil {
		return nil, err
	}
	repository, err := fsutil.NewFS(filepath.Join(dir, "src"))
	if err != nil {
		return nil, fmt.Errorf("railpack context: %w", err)
	}
	plan, err := fsutil.NewFS(filepath.Join(dir, "plan"))
	if err != nil {
		return nil, fmt.Errorf("railpack plan: %w", err)
	}
	options := RailpackOptions(request)
	options.LocalMounts = map[string]fsutil.FS{"context": repository, "dockerfile": plan}
	// The repository is on disk now: the Git token is not served to the frontend. The arguments
	// are, under their names, as Railpack reads them.
	options.Session = []session.Attachable{
		secretsprovider.FromMap(argSecrets(request.Args)),
		&registryAuth{credentials: request.Registry},
	}
	return solve(output, func(progress chan *client.SolveStatus) (*client.SolveResponse, error) {
		return daemon.Solve(ctx, nil, options, progress)
	})
}

func argSecrets(args map[string]string) map[string][]byte {
	served := make(map[string][]byte, len(args))
	for name, value := range args {
		served[name] = []byte(value)
	}
	return served
}

// NixpacksOutput is what `nixpacks build --out` writes for the repository: `.nixpacks/`, with its
// Dockerfile. The binary comes from its pinned release archive and runs alone, without network,
// the repository mounted read-only.
func NixpacksOutput(request Request, source llb.State, arch string) (llb.State, error) {
	release, ok := nixpacksRelease[arch]
	if !ok {
		return llb.State{}, fmt.Errorf("nixpacks has no release for %s", arch)
	}
	archive := llb.HTTP(release.url, llb.Checksum(release.sha256), llb.Filename("nixpacks.tar.gz"), llb.WithCustomName("fetch nixpacks"))
	binary := llb.Scratch().File(
		llb.Copy(archive, "nixpacks.tar.gz", "/", &llb.CopyInfo{AttemptUnpack: true}),
		llb.WithCustomName("unpack nixpacks"),
	)
	args := append([]string{
		"/nixpacks", "build", "/src", "--out", "/out", "--cache-key", request.CacheNamespace,
	}, envFlags(request.Args)...)
	run := binary.Run(
		llb.Args(args),
		llb.AddMount("/src", source, llb.Readonly),
		llb.Network(llb.NetModeNone),
		llb.WithCustomName("nixpacks build"),
	)
	return run.AddMount("/out", llb.Scratch()), nil
}

// nixpacksBuild writes Nixpacks' Dockerfile, reads the build arguments it would have passed, and
// builds that Dockerfile over the repository with BuildKit's Dockerfile frontend.
func nixpacksBuild(request Request, source llb.State, arch string) gateway.BuildFunc {
	return func(ctx context.Context, c gateway.Client) (*gateway.Result, error) {
		generated, err := NixpacksOutput(request, source, arch)
		if err != nil {
			return nil, err
		}
		definition, err := generated.Marshal(ctx)
		if err != nil {
			return nil, fmt.Errorf("nixpacks build: %w", err)
		}
		written, err := c.Solve(ctx, gateway.SolveRequest{Definition: definition.ToPB(), Evaluate: true})
		if err != nil {
			return nil, fmt.Errorf("nixpacks build: %w", err)
		}
		ref, err := written.SingleRef()
		if err != nil {
			return nil, fmt.Errorf("nixpacks output: %w", err)
		}
		// One byte more than the bound: a longer script is refused, never cut.
		script, err := ref.ReadFile(ctx, gateway.ReadRequest{
			Filename: nixpacksScript,
			Range:    &gateway.FileRange{Length: maxNixpacksScript + 1},
		})
		if err != nil {
			return nil, fmt.Errorf("nixpacks build script: %w", err)
		}
		if len(script) > maxNixpacksScript {
			return nil, errors.New("nixpacks wrote a build script longer than 64 KiB")
		}
		attrs := map[string]string{"filename": nixpacksFile}
		args := NixpacksBuildArgs(script)
		for name, value := range request.Args {
			args[name] = value
		}
		for name, value := range args {
			attrs["build-arg:"+name] = value
		}
		attrs["build-arg:BUILDKIT_CACHE_MOUNT_NS"] = request.CacheNamespace
		merged, err := NixpacksContext(source, generated).Marshal(ctx)
		if err != nil {
			return nil, fmt.Errorf("nixpacks context: %w", err)
		}
		built, err := c.Solve(ctx, gateway.SolveRequest{
			Frontend:       "dockerfile.v0",
			FrontendOpt:    attrs,
			FrontendInputs: map[string]*pb.Definition{"context": merged.ToPB(), "dockerfile": merged.ToPB()},
		})
		if err != nil {
			return nil, fmt.Errorf("nixpacks Dockerfile: %w", err)
		}
		return built, nil
	}
}

// NixpacksContext is the repository with Nixpacks' files on top. Its own `.nixpacks`, if it has
// one, is removed first: only what Nixpacks wrote there is built.
func NixpacksContext(source, generated llb.State) llb.State {
	repository := source.File(
		llb.Rm("/.nixpacks", &llb.RmInfo{AllowNotFound: true}),
		llb.WithCustomName("remove the repository's .nixpacks"),
	)
	return llb.Merge([]llb.State{repository, generated})
}

// NixpacksBuildArgs reads the `--build-arg NAME=VALUE` pairs of the `docker build` command
// Nixpacks wrote, which it joins with spaces and never quotes: a value with a space is cut there.
// Only names of environment variables are kept, never BuildKit's own (`BUILDKIT_…`), which could
// change what builds the Dockerfile.
func NixpacksBuildArgs(script []byte) map[string]string {
	args := map[string]string{}
	if len(script) > maxNixpacksScript || !utf8.Valid(script) {
		return args
	}
	fields := strings.Fields(string(script))
	for i := 0; i+1 < len(fields) && len(args) < maxNixpacksArgs; i++ {
		if fields[i] != "--build-arg" {
			continue
		}
		i++
		name, value, ok := strings.Cut(fields[i], "=")
		if !ok || !nixpacksArgName.MatchString(name) || strings.HasPrefix(strings.ToUpper(name), "BUILDKIT_") || len(value) > maxNixpacksValue {
			continue
		}
		args[name] = value
	}
	return args
}
