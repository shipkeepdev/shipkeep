package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	org     = "0190f5a8-7b1c-7e2d-8f3a-0123456789a1"
	project = "0190f5a8-7b1c-7e2d-8f3a-0123456789a2"
	env     = "0190f5a8-7b1c-7e2d-8f3a-0123456789a3"
	app1    = "0190f5a8-7b1c-7e2d-8f3a-0123456789a4"
	token   = "fixture-token-value-not-a-real-one"
	base    = "/api/v1/organizations/" + org + "/projects/" + project + "/environments/" + env
)

type harness struct {
	app      *App
	out, err *bytes.Buffer
	file     string
	vars     map[string]string
	input    string
	requests []string
	bodies   map[string]string
	auth     []string
}

func newHarness(t *testing.T, handler http.HandlerFunc) *harness {
	t.Helper()
	h := &harness{
		out:    &bytes.Buffer{},
		err:    &bytes.Buffer{},
		file:   filepath.Join(t.TempDir(), "shipkeep", "credentials.json"),
		vars:   map[string]string{},
		bodies: map[string]string{},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Method + " " + r.URL.EscapedPath()
		h.requests = append(h.requests, key)
		h.auth = append(h.auth, r.Header.Get("Authorization"))
		body, _ := io.ReadAll(r.Body)
		h.bodies[key] = string(body)
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	h.vars["SHIPKEEP_URL"] = server.URL
	h.vars["SHIPKEEP_TOKEN"] = token
	h.app = &App{
		In:              strings.NewReader(""),
		Out:             h.out,
		Err:             h.err,
		Getenv:          func(name string) string { return h.vars[name] },
		CredentialsPath: func() (string, error) { return h.file, nil },
		ReadSecret:      func(string) (string, error) { return h.input, nil },
	}
	return h
}

func (h *harness) run(args ...string) int {
	return h.app.Run(context.Background(), args)
}

func (h *harness) noSecretPrinted(t *testing.T, values ...string) {
	t.Helper()
	output := h.out.String() + h.err.String()
	for _, value := range values {
		if strings.Contains(output, value) {
			t.Fatalf("a secret reached the output: %q", output)
		}
	}
}

func answer(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func targetArgs() []string {
	return []string{"--org", org, "--project", project, "--env", env}
}

func TestLoginStoresAProtectedFileAndNeverPrintsTheToken(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		answer(w, http.StatusOK, map[string]string{"email": "a@example.com"})
	})
	h.input = token
	address := h.vars["SHIPKEEP_URL"]
	delete(h.vars, "SHIPKEEP_TOKEN")

	if code := h.run("login", "--url", address); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	info, err := os.Stat(h.file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials mode = %o, want 600", info.Mode().Perm())
	}
	if h.auth[0] != "Bearer "+token {
		t.Fatal("the token was not sent to verify it")
	}
	h.noSecretPrinted(t, token)
}

func TestLoginAcceptsAScopedTokenButNotARefusedOne(t *testing.T) {
	t.Parallel()
	for status, want := range map[int]int{http.StatusForbidden: 0, http.StatusUnauthorized: 1} {
		h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
			answer(w, status, map[string]string{"code": "denied"})
		})
		h.input = token
		address := h.vars["SHIPKEEP_URL"]
		if code := h.run("login", "--url", address); code != want {
			t.Fatalf("status %d: exit %d, want %d", status, code, want)
		}
		_, err := os.Stat(h.file)
		if saved := err == nil; saved != (want == 0) {
			t.Fatalf("status %d: saved = %v", status, saved)
		}
		h.noSecretPrinted(t, token)
	}
}

func TestLoginRefusesATokenOnTheCommandLineAndPlainHTTP(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(http.ResponseWriter, *http.Request) {
		t.Error("nothing may be sent")
	})
	h.input = token
	address := h.vars["SHIPKEEP_URL"]
	if code := h.run("login", "--url", address, "--token", token); code != 2 {
		t.Fatalf("--token: exit %d, want 2", code)
	}
	for _, unsafe := range []string{
		"http://shipkeep.example.com",
		"ftp://shipkeep.example.com",
		"https://user:pass@shipkeep.example.com",
		"https://shipkeep.example.com/path",
		"https://shipkeep.example.com?x=1",
		"http://localhost.evil.example",
		"file:///etc/passwd",
		"",
	} {
		if code := h.run("login", "--url", unsafe); code == 0 {
			t.Fatalf("%q was accepted", unsafe)
		}
	}
	if _, err := os.Stat(h.file); err == nil {
		t.Fatal("credentials were saved")
	}
}

func TestSavedLoginIsUsedAndExposedFilesRefused(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		answer(w, http.StatusOK, map[string]any{"items": []any{}})
	})
	h.input = token
	address := h.vars["SHIPKEEP_URL"]
	if code := h.run("login", "--url", address); code != 0 {
		t.Fatal(h.err.String())
	}
	delete(h.vars, "SHIPKEEP_TOKEN")
	delete(h.vars, "SHIPKEEP_URL")
	if code := h.run(append([]string{"status"}, targetArgs()...)...); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	if err := os.Chmod(h.file, 0o644); err != nil { //nolint:gosec // The exposure under test.
		t.Fatal(err)
	}
	h.err.Reset()
	if code := h.run(append([]string{"status"}, targetArgs()...)...); code != 1 {
		t.Fatalf("a readable credentials file was used: exit %d", code)
	}
	if !strings.Contains(h.err.String(), "other users") {
		t.Fatalf("stderr = %q", h.err.String())
	}
	h.noSecretPrinted(t, token)
	if code := h.run("logout"); code != 0 {
		t.Fatal(h.err.String())
	}
	if _, err := os.Stat(h.file); err == nil {
		t.Fatal("logout left the file")
	}
	if code := h.run("logout"); code != 0 {
		t.Fatal("a second logout must succeed")
	}
}

func TestNoRedirectIsFollowed(t *testing.T) {
	t.Parallel()
	evil := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		t.Errorf("the token followed a redirect: %q", r.Header.Get("Authorization"))
	}))
	defer evil.Close()
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/steal", http.StatusTemporaryRedirect)
	})
	if code := h.run(append([]string{"secrets", "list"}, targetArgs()...)...); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
}

func TestTargetsAreCheckedBeforeAnyRequest(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(http.ResponseWriter, *http.Request) {
		t.Error("nothing may be sent")
	})
	for _, bad := range []string{
		"", "../../admin", "not-a-uuid", org + "/../..", org + "?x=1", "%2e%2e", strings.ToUpper(org),
		"0190f5a8-7b1c-4e2d-8f3a-0123456789a1",
	} {
		if code := h.run("status", "--org", bad, "--project", project, "--env", env); code == 0 {
			t.Fatalf("%q was accepted", bad)
		}
	}
}

func TestEnvironmentVariablesNameTheTarget(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		answer(w, http.StatusOK, map[string]any{"items": []any{}})
	})
	h.vars["SHIPKEEP_ORG"], h.vars["SHIPKEEP_PROJECT"], h.vars["SHIPKEEP_ENV"] = org, project, env
	if code := h.run("secrets", "list"); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	if h.requests[0] != "GET "+base+"/secrets" {
		t.Fatalf("request = %q", h.requests[0])
	}
}

func TestSecretValueComesFromInputAndIsNeverPrinted(t *testing.T) {
	t.Parallel()
	const value = "s3cret-value-fixture"
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		answer(w, http.StatusOK, map[string]string{"name": "DATABASE_URL"})
	})
	h.input = value
	if code := h.run(append([]string{"secrets", "set", "DATABASE_URL"}, targetArgs()...)...); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	var sent map[string]string
	if err := json.Unmarshal([]byte(h.bodies["POST "+base+"/secrets"]), &sent); err != nil {
		t.Fatal(err)
	}
	if sent["name"] != "DATABASE_URL" || sent["value"] != value {
		t.Fatalf("body = %v", sent)
	}
	h.noSecretPrinted(t, value, token)

	// An API error echoing the value still must not print the token.
	if code := h.run(append([]string{"secrets", "set", "DATABASE_URL", "--value", "x"}, targetArgs()...)...); code != 2 {
		t.Fatalf("--value: exit %d, want 2", code)
	}
}

func TestSecretRefusals(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(http.ResponseWriter, *http.Request) {
		t.Error("nothing may be sent")
	})
	for _, name := range []string{
		"lower", "../ETC", "A/B", "A B", "A;B", "A%2FB", "$(id)", strings.Repeat("A", 129), "",
	} {
		if code := h.run(append([]string{"secrets", "set", name}, targetArgs()...)...); code == 0 {
			t.Fatalf("set %q was accepted", name)
		}
		if code := h.run(append([]string{"secrets", "unset", name}, targetArgs()...)...); code == 0 {
			t.Fatalf("unset %q was accepted", name)
		}
	}
	h.input = ""
	if code := h.run(append([]string{"secrets", "set", "EMPTY"}, targetArgs()...)...); code != 1 {
		t.Fatalf("an empty value: exit %d, want 1", code)
	}
	h.input = strings.Repeat("x", maxSecretBytes+1)
	if code := h.run(append([]string{"secrets", "set", "HUGE"}, targetArgs()...)...); code != 1 {
		t.Fatalf("an oversized value: exit %d, want 1", code)
	}
}

func TestSecretsListAndUnset(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			answer(w, http.StatusOK, map[string]any{"items": []map[string]any{{"name": "API_KEY", "version": 1}}})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if code := h.run(append([]string{"secrets", "list"}, targetArgs()...)...); code != 0 {
		t.Fatal(h.err.String())
	}
	if strings.TrimSpace(h.out.String()) != "API_KEY" {
		t.Fatalf("stdout = %q", h.out.String())
	}
	if code := h.run(append([]string{"secrets", "unset", "API_KEY"}, targetArgs()...)...); code != 0 {
		t.Fatal(h.err.String())
	}
	if h.requests[len(h.requests)-1] != "POST "+base+"/secrets/API_KEY/remove" {
		t.Fatalf("request = %q", h.requests[len(h.requests)-1])
	}
}

func TestServerTextCannotControlTheTerminal(t *testing.T) {
	t.Parallel()
	const hostile = "gone\x1b[2J\x1b]0;owned\x07\u202e"
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		answer(w, http.StatusConflict, map[string]string{"code": "c\x1b[31m", "detail": hostile})
	})
	if code := h.run(append([]string{"secrets", "list"}, targetArgs()...)...); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if strings.ContainsAny(h.err.String(), "\x1b\x07\u202e") {
		t.Fatalf("control characters reached the terminal: %q", h.err.String())
	}
	if !strings.Contains(h.err.String(), "gone") {
		t.Fatalf("stderr = %q", h.err.String())
	}
}

func TestStatusSummarizesApplications(t *testing.T) {
	t.Parallel()
	running, stopped := "running", "exited"
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/applications"):
			answer(w, http.StatusOK, map[string]any{"items": []application{
				{ID: app1, Name: "web"},
			}})
		case strings.HasSuffix(r.URL.Path, "/deployments"):
			answer(w, http.StatusOK, map[string]any{"items": []deployment{{ID: "d", State: "succeeded"}}})
		default:
			answer(w, http.StatusOK, map[string]any{"items": []replica{
				{Replica: 0, NodeName: "a", State: &running},
				{Replica: 1, NodeName: "b", State: &stopped},
				{Replica: 2, NodeName: "c"},
			}})
		}
	})
	if code := h.run(append([]string{"status"}, targetArgs()...)...); code != 0 {
		t.Fatal(h.err.String())
	}
	for _, want := range []string{"web", "succeeded", "1 of 3 running"} {
		if !strings.Contains(h.out.String(), want) {
			t.Fatalf("%q is missing from %q", want, h.out.String())
		}
	}
	if code := h.run(append([]string{"status", "--app", "missing"}, targetArgs()...)...); code != 1 {
		t.Fatal("an unknown application must fail")
	}
}

func TestStatusRefusesAnApplicationIDThatWouldChangeTheURL(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, _ *http.Request) {
		answer(w, http.StatusOK, map[string]any{"items": []application{{ID: "../../../admin", Name: "x"}}})
	})
	if code := h.run(append([]string{"status"}, targetArgs()...)...); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if len(h.requests) != 1 {
		t.Fatalf("requests = %v", h.requests)
	}
}

func TestInitWritesAValidFileAndKeepsAnExistingOne(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(http.ResponseWriter, *http.Request) {})
	file := filepath.Join(t.TempDir(), "shipkeep.yml")
	args := []string{"init", "--name", "web", "--image", "nginx:1.27", "--port", "8080", "--file", file}
	if code := h.run(args...); code != 0 {
		t.Fatal(h.err.String())
	}
	first, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(first), "port: 8080") {
		t.Fatalf("file = %q", first)
	}
	if code := h.run("init", "--name", "other", "--image", "nginx:1.27", "--file", file); code != 1 {
		t.Fatal("an existing file was replaced")
	}
	kept, _ := os.ReadFile(file)
	if !bytes.Equal(first, kept) {
		t.Fatal("the existing file changed")
	}
	if code := h.run("init", "--name", "other", "--image", "nginx:1.27", "--file", file, "--force"); code != 0 {
		t.Fatal(h.err.String())
	}
}

func TestInitRefusesInvalidAndInjectedValues(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(http.ResponseWriter, *http.Request) {})
	file := filepath.Join(t.TempDir(), "shipkeep.yml")
	for _, values := range [][2]string{
		{"../../etc", "nginx:1.27"},
		{"web\nprivileged: true", "nginx:1.27"},
		{`web"` + "\nextra: true\n#", "nginx:1.27"},
		{"web", "nginx;rm -rf /"},
		{"web", "nginx\nextra: true"},
		{"", "nginx:1.27"},
		{"web", ""},
	} {
		if code := h.run("init", "--name", values[0], "--image", values[1], "--file", file); code == 0 {
			t.Fatalf("%q was accepted", values)
		}
	}
	if code := h.run("init", "--name", "web", "--image", "nginx:1.27", "--port", "99999", "--file", file); code == 0 {
		t.Fatal("an invalid port was accepted")
	}
	if _, err := os.Stat(file); err == nil {
		t.Fatal("an invalid configuration was written")
	}
}

func TestReadAllDropsOnlyTheLastLineEnding(t *testing.T) {
	t.Parallel()
	for _, item := range []struct{ input, want string }{
		{"value\n", "value"},
		{"value\r\n", "value"},
		{"value\n\n", "value\n"},
		{" spaced value ", " spaced value "},
		{"", ""},
	} {
		got, err := readAll(strings.NewReader(item.input))
		if err != nil || got != item.want {
			t.Fatalf("readAll(%q) = %q, %v; want %q", item.input, got, err, item.want)
		}
	}
	if _, err := readAll(strings.NewReader(strings.Repeat("x", maxSecretBytes+5))); err == nil {
		t.Fatal("an oversized value was accepted")
	}
}
