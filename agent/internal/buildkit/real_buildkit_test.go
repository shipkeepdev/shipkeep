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
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

func TestRealBuildKitBuildsAndPushesARepositoryAtItsCommit(t *testing.T) {
	address := os.Getenv("SHIPKEEP_IT_BUILDKIT")
	registry := os.Getenv("SHIPKEEP_IT_BUILD_REGISTRY")
	registryURL := os.Getenv("SHIPKEEP_IT_BUILD_REGISTRY_URL")
	repository := os.Getenv("SHIPKEEP_IT_BUILD_REPOSITORY")
	commit := os.Getenv("SHIPKEEP_IT_BUILD_COMMIT")
	if address == "" || registry == "" || registryURL == "" || repository == "" || commit == "" {
		t.Skip("no BuildKit daemon configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	target := registry + "/it/app:" + commit[:12]
	var lines []string
	digest, err := Client{Address: address}.Build(ctx, Request{
		Repository: repository,
		Commit:     commit,
		Context:    "agent/internal/buildkit/testdata/app",
		Dockerfile: "Dockerfile",
		Args:       map[string]string{"GREETING": "hi"},
		Target:     target,
		Registry:   Credentials{Host: registry, Username: "it", Password: secret.NewString("it-password")},
	}, func(line string) { lines = append(lines, line) })
	output := strings.Join(lines, "\n")
	if err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	if !digestFormat.MatchString(digest) {
		t.Fatalf("digest = %q", digest)
	}
	// The step's output arrived, numbered, with the build argument applied.
	if !strings.Contains(output, "hi from the shipkeep build test") || !strings.HasPrefix(lines[0], "#1 ") {
		t.Fatalf("output:\n%s", output)
	}
	// The registry holds the tag, at the digest the build answered.
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, registryURL+"/v2/it/app/manifests/"+commit[:12], nil)
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
