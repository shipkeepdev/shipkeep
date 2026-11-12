package commands

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	release1 = "0190f5a8-7b1c-7e2d-8f3a-0123456789b1"
	release2 = "0190f5a8-7b1c-7e2d-8f3a-0123456789b2"
	dep1     = "0190f5a8-7b1c-7e2d-8f3a-0123456789c1"
	dep2     = "0190f5a8-7b1c-7e2d-8f3a-0123456789c2"
	dep3     = "0190f5a8-7b1c-7e2d-8f3a-0123456789c3"
	node1    = "0190f5a8-7b1c-7e2d-8f3a-0123456789d1"
	appPath  = base + "/applications/" + app1
	valid    = "version: 1\nname: web\nbuild:\n  type: image\n  image: nginx:1.27\nrun:\n  port: 80\n"
)

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "shipkeep.yml")
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

func deployArgs(file string, extra ...string) []string {
	args := append([]string{"deploy", "--file", file}, targetArgs()...)
	return append(args, extra...)
}

func TestDeployCreatesAMissingApplicationAndFollowsToSuccess(t *testing.T) {
	t.Parallel()
	polls := 0
	states := []string{"pulling", "pulling", "succeeded"}
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET " + base + "/applications":
			answer(w, http.StatusOK, map[string]any{"items": []any{}})
		case "POST " + base + "/applications":
			answer(w, http.StatusCreated, applicationDetails{ID: app1, Name: "web", ConfigSHA: "a"})
		case "POST " + appPath + "/deployments":
			answer(w, http.StatusCreated, queuedDeployment{Deployment: deployment{ID: dep1, State: "queued"}})
		case "GET " + appPath + "/deployments/" + dep1:
			answer(w, http.StatusOK, deployment{ID: dep1, State: states[polls]})
			polls++
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	h.app.PollEvery = time.Millisecond
	if code := h.run(deployArgs(writeConfig(t, valid))...); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	var sent struct {
		Config struct {
			Name string `json:"name"`
			Run  struct {
				Port int `json:"port"`
			} `json:"run"`
		} `json:"config"`
	}
	if err := json.Unmarshal([]byte(h.bodies["POST "+base+"/applications"]), &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Config.Name != "web" || sent.Config.Run.Port != 80 {
		t.Fatalf("config sent = %+v", sent.Config)
	}
	output := h.out.String()
	for _, want := range []string{"Created application web.", "queued", "pulling", "succeeded"} {
		if !strings.Contains(output, want) {
			t.Fatalf("%q is missing from %q", want, output)
		}
	}
	if strings.Count(output, "pulling") != 1 {
		t.Fatalf("an unchanged state was printed again: %q", output)
	}
}

func TestDeployUpdatesAnExistingApplicationWithItsHash(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET " + base + "/applications":
			answer(w, http.StatusOK, map[string]any{"items": []applicationDetails{
				{ID: dep1, Name: "other", ConfigSHA: "z"},
				{ID: app1, Name: "web", ConfigSHA: "known-hash"},
			}})
		case "POST " + appPath + "/config":
			answer(w, http.StatusOK, applicationDetails{ID: app1, Name: "web", ConfigSHA: "new"})
		case "POST " + appPath + "/deployments":
			answer(w, http.StatusCreated, queuedDeployment{Deployment: deployment{ID: dep1, State: "queued"}})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	if code := h.run(deployArgs(writeConfig(t, valid), "--no-wait")...); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	if !strings.Contains(h.bodies["POST "+appPath+"/config"], `"expectedConfigSha":"known-hash"`) {
		t.Fatalf("body = %s", h.bodies["POST "+appPath+"/config"])
	}
}

func TestDeployFailsWithTheServersReason(t *testing.T) {
	t.Parallel()
	reason := "image not found\x1b[2J"
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == base+"/applications" && r.Method == http.MethodGet:
			answer(w, http.StatusOK, map[string]any{"items": []applicationDetails{{ID: app1, Name: "web"}}})
		case r.URL.Path == appPath+"/config":
			answer(w, http.StatusOK, applicationDetails{ID: app1})
		case r.URL.Path == appPath+"/deployments":
			answer(w, http.StatusCreated, queuedDeployment{Deployment: deployment{ID: dep1, State: "queued"}})
		default:
			answer(w, http.StatusOK, deployment{ID: dep1, State: "failed", Error: &reason})
		}
	})
	h.app.PollEvery = time.Millisecond
	if code := h.run(deployArgs(writeConfig(t, valid))...); code != 1 {
		t.Fatalf("a failed deployment exited %d", code)
	}
	if !strings.Contains(h.err.String(), "image not found") || strings.ContainsRune(h.err.String(), 0x1b) {
		t.Fatalf("stderr = %q", h.err.String())
	}
}

func TestDeployStopsFollowingWithoutPretendingItFinished(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == base+"/applications" && r.Method == http.MethodGet:
			answer(w, http.StatusOK, map[string]any{"items": []applicationDetails{{ID: app1, Name: "web"}}})
		case r.URL.Path == appPath+"/config":
			answer(w, http.StatusOK, applicationDetails{ID: app1})
		case r.URL.Path == appPath+"/deployments":
			answer(w, http.StatusCreated, queuedDeployment{Deployment: deployment{ID: dep1, State: "queued"}})
		default:
			answer(w, http.StatusOK, deployment{ID: dep1, State: "pulling"})
		}
	})
	h.app.PollEvery = time.Millisecond
	if code := h.run(deployArgs(writeConfig(t, valid), "--timeout", "20ms")...); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(h.err.String(), "keeps running") {
		t.Fatalf("stderr = %q", h.err.String())
	}
}

func TestDeployRefusesAnInvalidFileBeforeAnyRequest(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(http.ResponseWriter, *http.Request) {
		t.Error("nothing may be sent")
	})
	for _, content := range []string{
		"", "not: [valid", "version: 1\nname: ../../etc\n",
		valid + "privileged: true\n",
		"version: 1\nname: web\nbuild:\n  type: image\n  image: \"nginx;rm -rf /\"\nrun:\n  port: 80\n",
	} {
		if code := h.run(deployArgs(writeConfig(t, content))...); code == 0 {
			t.Fatalf("%q was deployed", content)
		}
	}
	if code := h.run(deployArgs(filepath.Join(t.TempDir(), "missing.yml"))...); code != 1 {
		t.Fatal("a missing file must fail")
	}
}

func TestDeployRefusesIDsThatWouldChangeTheURL(t *testing.T) {
	t.Parallel()
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method + " " + r.URL.Path {
		case "GET " + base + "/applications":
			answer(w, http.StatusOK, map[string]any{"items": []applicationDetails{{ID: "../../admin", Name: "web"}}})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	})
	if code := h.run(deployArgs(writeConfig(t, valid))...); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
}

func rollbackHandler(t *testing.T, items []deployment, called *string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == base+"/applications":
			answer(w, http.StatusOK, map[string]any{"items": []applicationDetails{{ID: app1, Name: "web"}}})
		case r.Method == http.MethodGet && r.URL.Path == appPath+"/deployments":
			answer(w, http.StatusOK, map[string]any{"items": items})
		case r.Method == http.MethodPost:
			*called = r.URL.Path
			answer(w, http.StatusCreated, queuedDeployment{Deployment: deployment{ID: dep3, State: "queued"}})
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}
}

func TestRollbackPicksTheLastGoodDeploymentOfAnotherRelease(t *testing.T) {
	t.Parallel()
	var called string
	h := newHarness(t, rollbackHandler(t, []deployment{
		{ID: dep3, ReleaseID: release2, State: "failed"},
		{ID: dep2, ReleaseID: release2, State: "succeeded"},
		{ID: dep2, ReleaseID: release2, State: "succeeded"},
		{ID: dep1, ReleaseID: release1, State: "succeeded"},
	}, &called))
	args := append([]string{"rollback", "--app", "web", "--no-wait"}, targetArgs()...)
	if code := h.run(args...); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	if called != appPath+"/deployments/"+dep1+"/rollback" {
		t.Fatalf("rollback called %q", called)
	}
}

func TestRollbackWithNothingToReturnTo(t *testing.T) {
	t.Parallel()
	for name, items := range map[string][]deployment{
		"empty":         {},
		"only serving":  {{ID: dep1, ReleaseID: release1, State: "succeeded"}},
		"same release":  {{ID: dep2, ReleaseID: release1, State: "succeeded"}, {ID: dep1, ReleaseID: release1, State: "succeeded"}},
		"never serving": {{ID: dep1, ReleaseID: release1, State: "failed"}},
	} {
		var called string
		h := newHarness(t, rollbackHandler(t, items, &called))
		args := append([]string{"rollback", "--app", "web"}, targetArgs()...)
		if code := h.run(args...); code != 1 {
			t.Fatalf("%s: exit %d, want 1", name, code)
		}
		if called != "" {
			t.Fatalf("%s: called %q", name, called)
		}
	}
}

func TestRollbackToAnExplicitDeployment(t *testing.T) {
	t.Parallel()
	var called string
	h := newHarness(t, rollbackHandler(t, nil, &called))
	args := append([]string{"rollback", "--app", "web", "--to", dep2, "--no-wait"}, targetArgs()...)
	if code := h.run(args...); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	if called != appPath+"/deployments/"+dep2+"/rollback" {
		t.Fatalf("rollback called %q", called)
	}
	for _, bad := range []string{"../../x", "not-an-id", dep2 + "/../.."} {
		args := append([]string{"rollback", "--app", "web", "--to", bad}, targetArgs()...)
		if code := h.run(args...); code == 0 {
			t.Fatalf("--to %q was accepted", bad)
		}
	}
}

func TestServerRemoveNeedsTheExactNameAndSpendsAConfirmation(t *testing.T) {
	t.Parallel()
	const confirmation = "confirmation-token-fixture"
	root := "/api/v1/organizations/" + org
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case root + "/confirmations":
			answer(w, http.StatusCreated, map[string]string{"id": "c", "token": confirmation})
		case root + "/nodes/" + node1 + "/remove":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	})
	if code := h.run("server", "remove", node1, "--org", org); code != 1 {
		t.Fatalf("without --confirm: exit %d, want 1", code)
	}
	if len(h.requests) != 0 {
		t.Fatalf("requests without confirmation: %v", h.requests)
	}
	if code := h.run("server", "remove", node1, "--org", org, "--confirm", "edge-1"); code != 0 {
		t.Fatalf("exit %d: %s", code, h.err.String())
	}
	sent := h.bodies["POST "+root+"/confirmations"]
	for _, want := range []string{`"action":"node.remove"`, `"target":"` + node1 + `"`, `"name":"edge-1"`} {
		if !strings.Contains(sent, want) {
			t.Fatalf("%s is missing from %s", want, sent)
		}
	}
	if !strings.Contains(h.bodies["POST "+root+"/nodes/"+node1+"/remove"], confirmation) {
		t.Fatal("the confirmation was not sent")
	}
	h.noSecretPrinted(t, confirmation, token)
}

func TestServerRemoveRefusesBadInputAndStopsOnARefusal(t *testing.T) {
	t.Parallel()
	root := "/api/v1/organizations/" + org
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != root+"/confirmations" {
			t.Errorf("the removal ran after a refused confirmation: %s", r.URL.Path)
		}
		answer(w, http.StatusBadRequest, map[string]string{"code": "confirmation_name_mismatch"})
	})
	for _, id := range []string{"../../x", "not-an-id", ""} {
		if code := h.run("server", "remove", id, "--org", org, "--confirm", "x"); code == 0 {
			t.Fatalf("server %q was accepted", id)
		}
	}
	if code := h.run("server", "remove", node1, "--org", "../x", "--confirm", "x"); code == 0 {
		t.Fatal("a bad organization was accepted")
	}
	if code := h.run("server", "remove"); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if code := h.run("server", "add"); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if code := h.run("server", "remove", node1, "--org", org, "--confirm", "wrong"); code != 1 {
		t.Fatalf("exit %d, want 1", code)
	}
	if !strings.Contains(h.err.String(), "confirmation_name_mismatch") {
		t.Fatalf("stderr = %q", h.err.String())
	}
}
