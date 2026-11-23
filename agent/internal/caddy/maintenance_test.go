package caddy

import (
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"strings"
	"testing"
)

// The page is fixed, self-contained and allowed by its own policy only (ADR 0025).
func TestMaintenancePageIsSelfContained(t *testing.T) {
	handler := MaintenanceHandler()
	if handler.Handler != "static_response" || handler.StatusCode != 503 || len(handler.Upstreams) != 0 {
		t.Fatalf("not a 503 static response: %+v", handler)
	}
	for header, want := range map[string]string{
		"Content-Type":           "text/html; charset=utf-8",
		"Retry-After":            MaintenanceRetryAfter,
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := handler.Headers[header]; len(got) != 1 || got[0] != want {
			t.Errorf("%s = %v, want %q", header, got, want)
		}
	}
	// The policy allows the page's one style by its hash, and nothing else.
	style := regexp.MustCompile(`<style>(.*?)</style>`).FindStringSubmatch(handler.Body)
	if len(style) != 2 || strings.Count(handler.Body, "<style>") != 1 {
		t.Fatal("the page should carry exactly one style element")
	}
	sum := sha256.Sum256([]byte(style[1]))
	policy := handler.Headers["Content-Security-Policy"]
	if len(policy) != 1 || !strings.HasPrefix(policy[0], "default-src 'none'; style-src 'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'") {
		t.Fatalf("the policy does not allow the page's style by its hash: %v", policy)
	}
	body := strings.ToLower(handler.Body)
	for _, forbidden := range []string{"<script", "<img", "<link", "<form", "<iframe", "http:", "https:", "style=", " on"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("the page contains %q", forbidden)
		}
	}
	// Caddy replaces placeholders in a static body: the CSS blocks must not read as one.
	if placeholder := regexp.MustCompile(`\{(http|env|system|time|file|vars|tls)\.`).FindString(handler.Body); placeholder != "" {
		t.Fatalf("the page holds a Caddy placeholder: %s", placeholder)
	}
}
