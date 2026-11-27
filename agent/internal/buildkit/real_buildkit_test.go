//go:build integration

package buildkit

// ADR 0030 against a real BuildKit daemon: a repository fetched over HTTPS at its commit, built
// with the Dockerfile frontend, pushed to a registry, and its digest answered. The CI job "Agent
// against Docker and Caddy" starts BuildKit and a registry, and passes:
//   - SHIPKEEP_IT_BUILDKIT: the daemon's address (unix:// or tcp://);
//   - SHIPKEEP_IT_BUILD_REGISTRY: the registry's host:port as BuildKit reaches it;
//   - SHIPKEEP_IT_BUILD_REGISTRY_URL: the registry's base URL as the test reaches it;
//   - SHIPKEEP_IT_BUILD_REPOSITORY and SHIPKEEP_IT_BUILD_COMMIT: this repository on GitHub, at a
//     commit that holds agent/internal/buildkit/testdata.
// Without them, the test is skipped.

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

type realBuild struct {
	address, registry, registryURL, repository, commit string
}

func realBuildKit(t *testing.T) realBuild {
	t.Helper()
	build := realBuild{
		address:     os.Getenv("SHIPKEEP_IT_BUILDKIT"),
		registry:    os.Getenv("SHIPKEEP_IT_BUILD_REGISTRY"),
		registryURL: os.Getenv("SHIPKEEP_IT_BUILD_REGISTRY_URL"),
		repository:  os.Getenv("SHIPKEEP_IT_BUILD_REPOSITORY"),
		commit:      os.Getenv("SHIPKEEP_IT_BUILD_COMMIT"),
	}
	if build.address == "" || build.registry == "" || build.registryURL == "" || build.repository == "" || build.commit == "" {
		t.Skip("no BuildKit daemon configured")
	}
	return build
}

// pushed checks that the registry holds the tag, at the digest the build answered.
func (b realBuild) pushed(ctx context.Context, t *testing.T, repository, tag, digest string) {
	t.Helper()
	if !digestFormat.MatchString(digest) {
		t.Fatalf("digest = %q", digest)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, b.registryURL+"/v2/"+repository+"/manifests/"+tag, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept", "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Docker-Content-Digest") != digest {
		t.Fatalf("registry: %d %s, build answered %s", response.StatusCode, response.Header.Get("Docker-Content-Digest"), digest)
	}
}

func TestRealBuildKitBuildsAndPushesARepositoryAtItsCommit(t *testing.T) {
	build := realBuildKit(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	target := build.registry + "/it/app:" + build.commit[:12]
	var lines []string
	digest, err := Client{Address: build.address}.Build(ctx, Request{
		Repository: build.repository,
		Commit:     build.commit,
		Context:    "agent/internal/buildkit/testdata/app",
		Dockerfile: "Dockerfile",
		Args:       map[string]string{"GREETING": "hi"},
		Target:     target,
		Registry:   Credentials{Host: build.registry, Username: "it", Password: secret.NewString("it-password")},
	}, func(line string) { lines = append(lines, line) })
	output := strings.Join(lines, "\n")
	if err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	// The step's output arrived, numbered, with the build argument applied.
	if !strings.Contains(output, "hi from the shipkeep build test") || !strings.HasPrefix(lines[0], "#1 ") {
		t.Fatalf("output:\n%s", output)
	}
	build.pushed(ctx, t, "it/app", build.commit[:12], digest)
}

// ADR 0030: a Node application without a Dockerfile, built by Railpack and by Nixpacks from the
// repository at its commit, and pushed. Railpack's copy of the repository is gone afterwards.
func TestRealBuildKitBuildsWithRailpackAndNixpacks(t *testing.T) {
	build := realBuildKit(t)
	for _, kind := range []struct {
		name string
		kind Kind
		step string
	}{
		{name: "railpack", kind: Railpack, step: "railpack prepare"},
		{name: "nixpacks", kind: Nixpacks, step: "nixpacks build"},
	} {
		t.Run(kind.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
			defer cancel()
			work := t.TempDir()
			repository := "it/" + kind.name
			var lines []string
			started := time.Now()
			digest, err := Client{Address: build.address, WorkDir: filepath.Join(work, "builds")}.Build(ctx, Request{
				Kind:       kind.kind,
				Repository: build.repository,
				Commit:     build.commit,
				Context:    "agent/internal/buildkit/testdata/node",
				Args:       map[string]string{"GREETING": "hi"},
				Target:     build.registry + "/" + repository + ":" + build.commit[:12],
				Registry:   Credentials{Host: build.registry, Username: "it", Password: secret.NewString("it-password")},
			}, func(line string) { lines = append(lines, line) })
			output := strings.Join(lines, "\n")
			if err != nil {
				t.Fatalf("build: %v\n%s", err, output)
			}
			t.Logf("%s built in %s", kind.name, time.Since(started).Round(time.Second))
			if !strings.Contains(output, kind.step) {
				t.Fatalf("output:\n%s", output)
			}
			build.pushed(ctx, t, repository, build.commit[:12], digest)
			if entries, err := os.ReadDir(filepath.Join(work, "builds")); err == nil && len(entries) != 0 {
				t.Fatalf("the build left %d entries on disk", len(entries))
			}
		})
	}
}
