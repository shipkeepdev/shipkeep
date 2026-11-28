package actions

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/shipkeepdev/shipkeep/agent/internal/buildkit"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/shipkeepdev/shipkeep/lib/secret"
)

// Builder runs one build and answers the pushed image's digest (agent/internal/buildkit).
type Builder interface {
	Build(ctx context.Context, request buildkit.Request, line func(string)) (string, error)
}

// BuildLines receives the output of a build, a line at a time, tagged with its action (ADR 0032).
// It must not block: a build never waits for its output to be sent.
type BuildLines interface {
	Line(actionID, line string)
}

// WithBuilds runs BuildImage actions with builder, its output going to lines (ADR 0030, 0032).
// Without it, BuildImage is refused as unsupported.
func WithBuilds(builder Builder, lines BuildLines) Option {
	return func(o *handlerOptions) { o.builds = &buildSettings{builder: builder, lines: lines} }
}

type buildSettings struct {
	builder Builder
	lines   BuildLines
	// bound, in tests only, shortens the build's timeout.
	bound func(time.Duration) time.Duration
}

const (
	causeBuildFailed        = "build_failed"
	causeBuildTimeout       = "build_timeout"
	causeBuilderUnavailable = "builder_unavailable"

	// A build lasts this long unless its action says otherwise, and never longer than the bound.
	defaultBuildTimeout = 30 * time.Minute
	minBuildTimeout     = time.Minute
	maxBuildTimeout     = 2 * time.Hour

	maxRepositoryURL = 512
	maxBuildPath     = 255
	maxBuildArgs     = 100
	maxBuildArgValue = 4096
	maxBuildLine     = 16 << 10
)

// buildKinds are the build types a server builds (ADR 0030).
var buildKinds = map[agentv1.BuildType]buildkit.Kind{
	agentv1.BuildType_BUILD_TYPE_DOCKERFILE: buildkit.Dockerfile,
	agentv1.BuildType_BUILD_TYPE_RAILPACK:   buildkit.Railpack,
	agentv1.BuildType_BUILD_TYPE_NIXPACKS:   buildkit.Nixpacks,
}

var (
	// A path inside the repository: relative segments of safe characters, never `.` or `..`.
	buildPathSegment = regexp.MustCompile(`^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*$`)
	buildArgName     = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
	commitHash       = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
	// A push target in the installation's registry: host[:port], lower-case path components, a tag.
	pushTarget = regexp.MustCompile(`^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?)/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,2}):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$`)
	// Git hosts: a DNS name of two labels or more, and an optional port.
	gitHost = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::[0-9]{1,5})?$`)
	gitPath = regexp.MustCompile(`^(?:/[A-Za-z0-9_][A-Za-z0-9._-]*){1,8}$`)
)

// buildImage validates a BuildImage action and plans it in the build lane (ADR 0032). The build is
// retry-safe as a whole: run again from its commit, it pushes the same tag, and BuildKit's cache
// makes the second run short.
func buildImage(settings *buildSettings, req *agentv1.ActionRequest) (journal.Plan, error) {
	action := req.GetBuildImage()
	request, timeout, err := buildRequest(action)
	if err != nil {
		return journal.Plan{}, err
	}
	actionID := req.GetActionId()
	redact := redactor(request.Token, request.Registry.Password)
	line := func(text string) {
		settings.lines.Line(actionID, boundedLine(redact(text)))
	}
	return journal.Plan{Version: "build-image-v1", Lane: journal.BuildLane, Steps: []journal.Step{{
		Name:      "build",
		RetrySafe: true,
		Apply: func(ctx context.Context) (journal.Outcome, error) {
			limit := timeout
			if settings.bound != nil {
				limit = settings.bound(timeout)
			}
			bounded, cancel := context.WithTimeout(ctx, limit)
			defer cancel()
			digest, err := settings.builder.Build(bounded, request, line)
			switch {
			case err == nil:
				return journal.Outcome{Digest: digest}, nil
			case errors.Is(err, buildkit.ErrUnavailable):
				return journal.Outcome{}, causeError{cause: causeBuilderUnavailable}
			case ctx.Err() != nil:
				// The action was interrupted: its journal resumes it, nothing failed.
				return journal.Outcome{}, ctx.Err()
			case bounded.Err() != nil:
				line("the build did not finish in time")
				return journal.Outcome{}, causeError{cause: causeBuildTimeout}
			default:
				// What failed before BuildKit printed it, such as the agent's own preparation.
				for _, text := range strings.Split(err.Error(), "\n") {
					line("the build failed: " + text)
				}
				return journal.Outcome{}, causeError{cause: causeBuildFailed}
			}
		},
		// A pushed tag stays in the registry: retention removes what no release names (ADR 0030).
		Compensate: func(context.Context) error { return nil },
	}}}, nil
}

// buildRequest checks every field before anything runs: the repository is HTTPS without
// credentials, paths stay inside it, the push goes to the registry the credentials are for.
func buildRequest(action *agentv1.BuildImage) (buildkit.Request, time.Duration, error) {
	if action == nil {
		return buildkit.Request{}, 0, errInput
	}
	kind, ok := buildKinds[action.GetBuildType()]
	if !ok {
		return buildkit.Request{}, 0, errInput
	}
	if !validRepositoryURL(action.GetRepoUrl()) || !commitHash.MatchString(action.GetCommitSha()) {
		return buildkit.Request{}, 0, errInput
	}
	token := action.GetGitToken()
	// A credential shorter than the redactor hides could reach the build's output: refused.
	if len(token) > 4096 || (token != "" && (len(token) < minHiddenSecret || !printable(token, 4096))) {
		return buildkit.Request{}, 0, errInput
	}
	context, ok := buildPath(action.GetContext(), true)
	if !ok {
		return buildkit.Request{}, 0, errInput
	}
	// Railpack and Nixpacks write their own build: a Dockerfile path means another build type.
	dockerfile := action.GetDockerfile()
	switch {
	case kind != buildkit.Dockerfile && dockerfile != "":
		return buildkit.Request{}, 0, errInput
	case kind == buildkit.Dockerfile && dockerfile == "":
		dockerfile = "Dockerfile"
	}
	if kind == buildkit.Dockerfile {
		if dockerfile, ok = buildPath(dockerfile, false); !ok {
			return buildkit.Request{}, 0, errInput
		}
	}
	args := action.GetArgs()
	if len(args) > maxBuildArgs {
		return buildkit.Request{}, 0, errInput
	}
	for name, value := range args {
		// BUILDKIT_… arguments are BuildKit's own settings, such as the cache namespace the agent
		// sets: an application never chooses them.
		if !buildArgName.MatchString(name) || strings.HasPrefix(name, "BUILDKIT_") || len(value) > maxBuildArgValue || !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
			return buildkit.Request{}, 0, errInput
		}
	}
	target := pushTarget.FindStringSubmatch(action.GetTargetRef())
	if len(action.GetTargetRef()) > 255 || target == nil {
		return buildkit.Request{}, 0, errInput
	}
	registry, err := registryAuth(action.GetPushCredentials(), target[1])
	if err != nil || registry == nil || len(registry.Password.Expose()) < minHiddenSecret {
		return buildkit.Request{}, 0, errInput
	}
	timeout, ok := buildTimeout(action.GetLimits())
	if !ok {
		return buildkit.Request{}, 0, errInput
	}
	return buildkit.Request{
		Kind:       kind,
		Repository: action.GetRepoUrl(),
		Commit:     action.GetCommitSha(),
		Token:      secret.NewString(token),
		Context:    context,
		Dockerfile: dockerfile,
		Args:       args,
		Target:     action.GetTargetRef(),
		Registry:   buildkit.Credentials{Host: registry.Server, Username: registry.Username, Password: registry.Password},
	}, timeout, nil
}

func validRepositoryURL(raw string) bool {
	if len(raw) > maxRepositoryURL || !printable(raw, maxRepositoryURL) {
		return false
	}
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.User == nil && parsed.RawQuery == "" &&
		parsed.Fragment == "" && !parsed.ForceQuery && parsed.Opaque == "" &&
		gitHost.MatchString(parsed.Host) && gitPath.MatchString(parsed.Path) && parsed.RawPath == ""
}

// buildPath is a path inside the repository, cleaned of nothing: anything but plain relative
// segments is refused. empty allows the repository's root.
func buildPath(value string, empty bool) (string, bool) {
	if value == "" {
		return "", empty
	}
	if len(value) > maxBuildPath {
		return "", false
	}
	for segment := range strings.SplitSeq(value, "/") {
		if !buildPathSegment.MatchString(segment) {
			return "", false
		}
	}
	return value, true
}

// buildTimeout reads the action's limits. CPU, memory and disk are those of the BuildKit unit the
// installer sets, one build at a time (ADR 0030, 0032): the action may not ask for more than it
// can be given, and its timeout bounds the build.
func buildTimeout(limits *agentv1.BuildImage_Limits) (time.Duration, bool) {
	if limits == nil {
		return defaultBuildTimeout, true
	}
	if limits.GetCpuMillis() > 64_000 || limits.GetMemoryBytes() > 256<<30 || limits.GetDiskBytes() > 1<<40 {
		return 0, false
	}
	if limits.GetTimeout() == nil {
		return defaultBuildTimeout, true
	}
	timeout := limits.GetTimeout().AsDuration()
	if limits.GetTimeout().CheckValid() != nil || timeout < minBuildTimeout || timeout > maxBuildTimeout {
		return 0, false
	}
	return timeout, true
}

// minHiddenSecret is the shortest secret the redactor hides: shorter ones would hide common
// text, so a build refuses credentials shorter than this instead of printing them.
const minHiddenSecret = 4

// redactor hides the build's own secrets from its output, whatever printed them.
func redactor(values ...secret.String) func(string) string {
	var hidden []string
	for _, value := range values {
		if text := value.Expose(); len(text) >= minHiddenSecret {
			hidden = append(hidden, text)
		}
	}
	return func(line string) string {
		for _, text := range hidden {
			line = strings.ReplaceAll(line, text, secret.Redacted)
		}
		return line
	}
}

// boundedLine is valid UTF-8 of at most 16 KiB, as every log line (ADR 0029).
func boundedLine(line string) string {
	line = strings.ToValidUTF8(line, "�")
	if len(line) <= maxBuildLine {
		return line
	}
	cut := maxBuildLine
	for cut > 0 && !utf8.RuneStart(line[cut]) {
		cut--
	}
	return line[:cut]
}

func buildResult(outcome journal.Outcome) *agentv1.ActionResult {
	return &agentv1.ActionResult{Result: &agentv1.ActionResult_BuildImage{BuildImage: &agentv1.ActionResult_BuildImageResult{ImageDigest: outcome.Digest}}}
}
