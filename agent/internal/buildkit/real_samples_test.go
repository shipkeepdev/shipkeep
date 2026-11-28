//go:build integration

package buildkit

// #215's acceptance against a real BuildKit daemon, set up as real_buildkit_test.go says:
// applications in each language the plan names, and Dockerfiles that reach for the host.

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

// A Python, a Go and a PHP application without a Dockerfile, each built by Railpack and by
// Nixpacks from the repository at its commit, and pushed (Node is in real_buildkit_test.go).
func TestRealBuildKitBuildsEachLanguage(t *testing.T) {
	build := realBuildKit(t)
	for _, language := range []string{"python", "go", "php"} {
		for _, builder := range []struct {
			name string
			kind Kind
		}{{"railpack", Railpack}, {"nixpacks", Nixpacks}} {
			t.Run(language+"/"+builder.name, func(t *testing.T) {
				t.Parallel()
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
				defer cancel()
				repository := "it/" + language + "-" + builder.name
				client := Client{Address: build.address, WorkDir: filepath.Join(t.TempDir(), "builds"), CacheSecret: []byte("shipkeep real build test key 32b")}
				var lines []string
				started := time.Now()
				digest, err := client.Build(ctx, Request{
					Kind:       builder.kind,
					Repository: build.repository,
					Commit:     build.commit,
					Context:    "agent/internal/buildkit/testdata/" + language,
					Target:     build.registry + "/" + repository + ":" + build.commit[:12],
					Registry:   Credentials{Host: build.registry, Username: "it", Password: secret.NewString("it-password")},
				}, func(line string) { lines = append(lines, line) })
				if err != nil {
					t.Fatalf("build: %v\n%s", err, strings.Join(lines, "\n"))
				}
				t.Logf("%s built in %s", language+"/"+builder.name, time.Since(started).Round(time.Second))
				build.pushed(ctx, t, repository, build.commit[:12], digest)
			})
		}
	}
}

// A Dockerfile that reaches for the host gets nothing: a build the agent sends asks for no
// entitlement, so a step on the host's network or a privileged one is refused, and a bind mount
// reads the repository, never the host's Docker socket. Nothing such a step would print ran.
func TestRealBuildKitKeepsADockerfileOffTheHost(t *testing.T) {
	build := realBuildKit(t)
	for _, c := range []struct{ dockerfile, refusal string }{
		{"network.Dockerfile", "network.host is not allowed"},
		{"privileged.Dockerfile", "security.insecure is not allowed"},
		{"socket.Dockerfile", "not found"},
	} {
		t.Run(c.dockerfile, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			client := Client{Address: build.address, CacheSecret: []byte("shipkeep real build test key 32b")}
			var lines []string
			_, err := client.Build(ctx, Request{
				Repository: build.repository,
				Commit:     build.commit,
				Context:    "agent/internal/buildkit/testdata/escape",
				Dockerfile: c.dockerfile,
				Target:     build.registry + "/it/escape:" + build.commit[:12],
				Registry:   Credentials{Host: build.registry, Username: "it", Password: secret.NewString("it-password")},
			}, func(line string) { lines = append(lines, line) })
			output := strings.Join(lines, "\n")
			if err == nil || !strings.Contains(err.Error(), c.refusal) || strings.Contains(output, "reached the host") {
				t.Fatalf("error: %v\noutput:\n%s", err, output)
			}
		})
	}
}
