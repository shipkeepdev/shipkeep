package actions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/shipkeepdev/shipkeep/agent/internal/buildkit"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/shipkeepdev/shipkeep/lib/secret"
)

const (
	buildCommit   = "0123456789abcdef0123456789abcdef01234567"
	buildRegistry = "cp.example.com"
	buildTarget   = "cp.example.com/0190f5a8-7b1c-7e2d-8f3a-0000000000aa/0190f5a8-7b1c-7e2d-8f3a-0000000000ab:7"
	buildToken    = "ghs_fakeInstallationToken0123456789" //nolint:gosec // a fake value for the tests
	buildPassword = "fakeRegistrySecret0123456789abcdefghijklmnopq"
)

type fakeBuilder struct {
	mu       sync.Mutex
	requests []buildkit.Request
	print    []string
	digest   string
	err      error
	wait     bool
}

func (b *fakeBuilder) Build(ctx context.Context, request buildkit.Request, line func(string)) (string, error) {
	b.mu.Lock()
	b.requests = append(b.requests, request)
	b.mu.Unlock()
	for _, text := range b.print {
		line(text)
	}
	if b.wait {
		<-ctx.Done()
		return "", fmt.Errorf("solve: %w", ctx.Err())
	}
	return b.digest, b.err
}

type lineRecorder struct {
	mu    sync.Mutex
	lines []string
}

func (r *lineRecorder) Line(actionID, line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, actionID+" "+line)
}

func validBuild() *agentv1.BuildImage {
	return &agentv1.BuildImage{
		RepoUrl:   "https://github.com/acme-corp/billing.git",
		CommitSha: buildCommit,
		GitToken:  buildToken,
		BuildType: agentv1.BuildType_BUILD_TYPE_DOCKERFILE,
		Context:   "services/api",
		Args:      map[string]string{"NODE_ENV": "production"},
		TargetRef: buildTarget,
		PushCredentials: &agentv1.RegistryCredentials{
			Server: buildRegistry, Username: "org.grant", Password: buildPassword,
			ExpiresAt: timestamppb.New(time.Now().Add(time.Hour)),
		},
		Limits: &agentv1.BuildImage_Limits{Timeout: durationpb.New(10 * time.Minute)},
	}
}

func runBuild(t *testing.T, builder Builder, lines BuildLines, action *agentv1.BuildImage) *agentv1.ActionUpdate {
	t.Helper()
	handlers := Registry(nil, nil, nil, nil, Handler{}, WithBuilds(builder, lines))
	d := &Dispatcher{Journal: open(t), Handlers: handlers, Epoch: func() uint64 { return 3 }}
	req := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_BuildImage{BuildImage: action}}
	req.ActionId, req.IdempotencyKey, req.LeaseEpoch = testID, "d:build", 3
	req.DeadlineUnixMs = time.Now().Add(time.Hour).UnixMilli()
	out := &recorder{}
	d.Handle(context.Background(), req, out.send)
	return out.last(t)
}

// ADR 0030: the repository at its commit, the context and Dockerfile inside it, the push to the
// registry the credentials are for, and the digest back.
func TestBuildImagePushesAndAnswersTheDigest(t *testing.T) {
	builder := &fakeBuilder{digest: "sha256:" + strings.Repeat("d", 64)}
	update := runBuild(t, builder, &lineRecorder{}, validBuild())
	if !succeeded(update) || update.GetResult().GetBuildImage().GetImageDigest() != builder.digest {
		t.Fatalf("build: %v", update)
	}
	if len(builder.requests) != 1 {
		t.Fatalf("%d builds", len(builder.requests))
	}
	got := builder.requests[0]
	if got.Kind != buildkit.Dockerfile || got.Repository != "https://github.com/acme-corp/billing.git" || got.Commit != buildCommit || got.Context != "services/api" ||
		got.Dockerfile != "Dockerfile" || got.Target != buildTarget || got.Args["NODE_ENV"] != "production" ||
		got.Token.Expose() != buildToken || got.Registry.Host != buildRegistry || got.Registry.Password.Expose() != buildPassword {
		t.Fatalf("request = %+v", got)
	}
	// Run in the build lane: the server's other actions are not held by it (ADR 0032).
	plan, err := buildImage(&buildSettings{builder: builder, lines: &lineRecorder{}}, &agentv1.ActionRequest{Action: &agentv1.ActionRequest_BuildImage{BuildImage: validBuild()}})
	if err != nil || plan.Lane != journal.BuildLane || len(plan.Steps) != 1 || !plan.Steps[0].RetrySafe {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
}

// ADR 0030: Railpack and Nixpacks write their own build, so they take no Dockerfile, and their
// arguments reach them as validated as a Dockerfile's.
func TestBuildImageBuildsWithRailpackAndNixpacks(t *testing.T) {
	for buildType, kind := range map[agentv1.BuildType]buildkit.Kind{
		agentv1.BuildType_BUILD_TYPE_RAILPACK: buildkit.Railpack,
		agentv1.BuildType_BUILD_TYPE_NIXPACKS: buildkit.Nixpacks,
	} {
		builder := &fakeBuilder{digest: "sha256:" + strings.Repeat("e", 64)}
		action := validBuild()
		action.BuildType = buildType
		action.Args = map[string]string{"NODE_ENV": "production", "FLAG": "--frontend=evil"}
		update := runBuild(t, builder, &lineRecorder{}, action)
		if !succeeded(update) || len(builder.requests) != 1 {
			t.Fatalf("%s: %v", buildType, update)
		}
		got := builder.requests[0]
		if got.Kind != kind || got.Dockerfile != "" || got.Context != "services/api" || got.Args["FLAG"] != "--frontend=evil" {
			t.Fatalf("%s: request = %+v", buildType, got)
		}
	}
}

// Every field is checked before anything runs: malicious values never reach BuildKit.
func TestBuildImageRefusesMaliciousInput(t *testing.T) {
	for name, change := range map[string]func(*agentv1.BuildImage){
		"plain HTTP":         func(b *agentv1.BuildImage) { b.RepoUrl = "http://github.com/acme/billing.git" },
		"SSH":                func(b *agentv1.BuildImage) { b.RepoUrl = "git@github.com:acme/billing.git" },
		"file":               func(b *agentv1.BuildImage) { b.RepoUrl = "file:///var/run/docker.sock" },
		"credentials in URL": func(b *agentv1.BuildImage) { b.RepoUrl = "https://user:pass@github.com/acme/billing.git" },
		"query":              func(b *agentv1.BuildImage) { b.RepoUrl = "https://github.com/acme/billing.git?ref=main" },
		"fragment":           func(b *agentv1.BuildImage) { b.RepoUrl = "https://github.com/acme/billing.git#main:sub" },
		"IP host":            func(b *agentv1.BuildImage) { b.RepoUrl = "https://169.254.169.254/latest/meta-data" },
		"localhost":          func(b *agentv1.BuildImage) { b.RepoUrl = "https://localhost/acme/billing.git" },
		"traversal in URL":   func(b *agentv1.BuildImage) { b.RepoUrl = "https://github.com/acme/../../etc/passwd" },
		"encoded URL":        func(b *agentv1.BuildImage) { b.RepoUrl = "https://github.com/acme/%2e%2e/billing.git" },
		"newline in URL":     func(b *agentv1.BuildImage) { b.RepoUrl = "https://github.com/acme/billing.git\nHost: x" },
		"oversized URL":      func(b *agentv1.BuildImage) { b.RepoUrl = "https://github.com/" + strings.Repeat("a", 600) },
		"short commit":       func(b *agentv1.BuildImage) { b.CommitSha = "0123456" },
		"branch as commit":   func(b *agentv1.BuildImage) { b.CommitSha = "main" },
		"uppercase commit":   func(b *agentv1.BuildImage) { b.CommitSha = strings.ToUpper(buildCommit) },
		"option as commit":   func(b *agentv1.BuildImage) { b.CommitSha = "--upload-pack=touch /tmp/x" },
		"control in token":   func(b *agentv1.BuildImage) { b.GitToken = "ghs_abc\r\nX-Injected: 1" },
		"oversized token":    func(b *agentv1.BuildImage) { b.GitToken = strings.Repeat("a", 4097) },
		"no build type":      func(b *agentv1.BuildImage) { b.BuildType = agentv1.BuildType_BUILD_TYPE_UNSPECIFIED },
		"unknown build type": func(b *agentv1.BuildImage) { b.BuildType = agentv1.BuildType(99) },
		"railpack Dockerfile": func(b *agentv1.BuildImage) {
			b.BuildType, b.Dockerfile = agentv1.BuildType_BUILD_TYPE_RAILPACK, "Dockerfile"
		},
		"nixpacks Dockerfile": func(b *agentv1.BuildImage) {
			b.BuildType, b.Dockerfile = agentv1.BuildType_BUILD_TYPE_NIXPACKS, "../../etc/passwd"
		},
		"absolute context":     func(b *agentv1.BuildImage) { b.Context = "/etc" },
		"context traversal":    func(b *agentv1.BuildImage) { b.Context = "services/../../etc" },
		"dot context":          func(b *agentv1.BuildImage) { b.Context = "." },
		"empty segment":        func(b *agentv1.BuildImage) { b.Context = "services//api" },
		"backslash":            func(b *agentv1.BuildImage) { b.Context = `services\..\etc` },
		"oversized context":    func(b *agentv1.BuildImage) { b.Context = strings.Repeat("a", 256) },
		"dockerfile traversal": func(b *agentv1.BuildImage) { b.Dockerfile = "../Dockerfile" },
		"absolute dockerfile":  func(b *agentv1.BuildImage) { b.Dockerfile = "/proc/self/environ" },
		"lower-case arg":       func(b *agentv1.BuildImage) { b.Args = map[string]string{"node_env": "x"} },
		"injected arg name":    func(b *agentv1.BuildImage) { b.Args = map[string]string{"A=B C": "x"} },
		"NUL in arg":           func(b *agentv1.BuildImage) { b.Args = map[string]string{"A": "x\x00y"} },
		"oversized arg":        func(b *agentv1.BuildImage) { b.Args = map[string]string{"A": strings.Repeat("x", 4097)} },
		"invalid UTF-8 arg":    func(b *agentv1.BuildImage) { b.Args = map[string]string{"A": "\xff"} },
		"too many args":        func(b *agentv1.BuildImage) { b.Args = manyArgs(101) },
		"BuildKit's own arg":   func(b *agentv1.BuildImage) { b.Args = map[string]string{"BUILDKIT_CACHE_MOUNT_NS": "other"} },
		"BuildKit frontend":    func(b *agentv1.BuildImage) { b.Args = map[string]string{"BUILDKIT_SYNTAX": "evil/frontend"} },
		"target on Docker Hub": func(b *agentv1.BuildImage) { b.TargetRef = "acme/billing:7" },
		"target elsewhere":     func(b *agentv1.BuildImage) { b.TargetRef = "evil.example/acme/billing:7" },
		"target by digest":     func(b *agentv1.BuildImage) { b.TargetRef = buildTarget + "@sha256:" + strings.Repeat("a", 64) },
		"target without tag":   func(b *agentv1.BuildImage) { b.TargetRef = strings.Split(buildTarget, ":")[0] },
		"upper-case target":    func(b *agentv1.BuildImage) { b.TargetRef = strings.ToUpper(buildTarget) },
		"no push credentials":  func(b *agentv1.BuildImage) { b.PushCredentials = nil },
		"expired credentials": func(b *agentv1.BuildImage) {
			b.PushCredentials.ExpiresAt = timestamppb.New(time.Now().Add(-time.Minute))
		},
		"credentials elsewhere": func(b *agentv1.BuildImage) { b.PushCredentials.Server = "evil.example" },
		"timeout too short":     func(b *agentv1.BuildImage) { b.Limits.Timeout = durationpb.New(time.Second) },
		"timeout too long":      func(b *agentv1.BuildImage) { b.Limits.Timeout = durationpb.New(3 * time.Hour) },
		"negative timeout":      func(b *agentv1.BuildImage) { b.Limits.Timeout = durationpb.New(-time.Minute) },
		"oversized memory":      func(b *agentv1.BuildImage) { b.Limits.MemoryBytes = 1 << 50 },
	} {
		action := validBuild()
		change(action)
		builder := &fakeBuilder{digest: "sha256:" + strings.Repeat("d", 64)}
		update := runBuild(t, builder, &lineRecorder{}, action)
		if update.GetError() != errInvalid || len(builder.requests) != 0 {
			t.Errorf("%s: %v, %d builds", name, update.GetError(), len(builder.requests))
		}
	}
}

func manyArgs(n int) map[string]string {
	args := map[string]string{}
	for i := range n {
		args[fmt.Sprintf("ARG_%d", i)] = "x"
	}
	return args
}

// The output goes to the log stream with the action's id, without the build's own secrets, valid
// and bounded, whatever printed it.
func TestBuildImageOutputHidesItsSecrets(t *testing.T) {
	builder := &fakeBuilder{
		digest: "sha256:" + strings.Repeat("d", 64),
		print: []string{
			"#1 [internal] load git source https://github.com/acme-corp/billing.git",
			"#2 RUN echo " + buildToken + " and " + buildPassword,
			"#3 " + strings.Repeat("é", 20_000),
			"#4 \xff\xfe",
		},
	}
	lines := &lineRecorder{}
	if update := runBuild(t, builder, lines, validBuild()); !succeeded(update) {
		t.Fatalf("build: %v", update)
	}
	if len(lines.lines) != 4 || !strings.HasPrefix(lines.lines[0], testID+" #1 ") {
		t.Fatalf("lines = %q", lines.lines)
	}
	for _, line := range lines.lines {
		if strings.Contains(line, buildToken) || strings.Contains(line, buildPassword) {
			t.Fatalf("a secret reached the output: %q", line)
		}
		if len(line) > len(testID)+1+maxBuildLine || !utf8Valid(line) {
			t.Fatalf("unbounded or invalid line of %d bytes", len(line))
		}
	}
}

func utf8Valid(s string) bool { return strings.ToValidUTF8(s, "") == s }

// A failed build, one that runs out of time and a builder that does not answer each fail with a
// fixed text the control plane knows (SPEC 3.4), never BuildKit's own message.
func TestBuildImageFailuresHaveFixedTexts(t *testing.T) {
	for _, c := range []struct {
		name    string
		builder *fakeBuilder
		text    string
	}{
		{"failed", &fakeBuilder{err: errors.New("nixpacks has no release for riscv64\nwith " + buildToken)}, "the build failed: its output says why"},
		{"unavailable", &fakeBuilder{err: fmt.Errorf("%w: dial unix", buildkit.ErrUnavailable)}, "the server's builder does not answer"},
		{"timeout", &fakeBuilder{wait: true}, "the build did not finish in time"},
	} {
		lines := &lineRecorder{}
		// The action's timeout, cut to a few milliseconds: the bound is the build's own.
		settings := &buildSettings{builder: c.builder, lines: lines, bound: func(time.Duration) time.Duration { return 20 * time.Millisecond }}
		handlers := map[string]Handler{"build_image": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return buildImage(settings, req)
		}, Result: buildResult}}
		d := &Dispatcher{Journal: open(t), Handlers: handlers, Epoch: func() uint64 { return 3 }}
		req := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_BuildImage{BuildImage: validBuild()}}
		req.ActionId, req.IdempotencyKey, req.LeaseEpoch = testID, "d:build", 3
		req.DeadlineUnixMs = time.Now().Add(time.Hour).UnixMilli()
		out := &recorder{}
		d.Handle(context.Background(), req, out.send)
		update := out.last(t)
		if update.GetState() != agentv1.OperationState_OPERATION_STATE_COMPENSATED || update.GetError() != c.text {
			t.Errorf("%s: %v %q", c.name, update.GetState(), update.GetError())
		}
		output := strings.Join(lines.lines, "\n")
		if c.name == "timeout" && !strings.Contains(output, "the build did not finish in time") {
			t.Errorf("the timeout is not in the output: %q", lines.lines)
		}
		// Why a build failed is in its output, each line of it, never the token: the action's
		// error stays a fixed text.
		if c.name == "failed" && (!strings.Contains(output, "the build failed: nixpacks has no release for riscv64") ||
			!strings.Contains(output, "the build failed: with "+secret.Redacted) || strings.Contains(output, buildToken)) {
			t.Errorf("the failure is not in the output: %q", lines.lines)
		}
	}
}

// Only a server builds: a control-plane-only machine refuses BuildImage as unsupported.
func TestBuildImageIsAServersAction(t *testing.T) {
	only := Registry(nil, nil, nil, nil, Handler{}, WithBuilds(&fakeBuilder{}, &lineRecorder{}), ControlPlaneOnly())
	if _, handled := only["build_image"]; handled {
		t.Fatal("a control-plane-only machine builds")
	}
	if _, handled := Registry(nil, nil, nil, nil, Handler{})["build_image"]; handled {
		t.Fatal("an agent without a builder accepts builds")
	}
}
