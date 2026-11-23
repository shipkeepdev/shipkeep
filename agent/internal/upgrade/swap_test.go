package upgrade

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// installed is an agent bin directory holding a running binary, and its state directory.
func installed(t *testing.T) (binary, stateDir string) {
	t.Helper()
	root := t.TempDir()
	binary = filepath.Join(root, "bin", "shipkeep-agent")
	stateDir = filepath.Join(root, "state")
	for _, dir := range []string{filepath.Dir(binary), stateDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(binary, []byte("old agent"), 0o755); err != nil { //nolint:gosec // an executable stand-in
		t.Fatal(err)
	}
	return binary, stateDir
}

func content(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// swapped runs the swap steps of an upgrade to `next`, as the handler does.
func swapped(t *testing.T, binary, stateDir, next string) {
	t.Helper()
	if err := WriteNext(binary, []byte(next)); err != nil {
		t.Fatal(err)
	}
	if err := LinkPrevious(binary); err != nil {
		t.Fatal(err)
	}
	digest, err := FileSHA256(binary + nextSuffix)
	if err != nil {
		t.Fatal(err)
	}
	record := Pending{From: "0.1.0", To: "0.2.0", Binary: binary, SHA256: digest, At: time.Unix(1, 0).UTC(), State: StatePending}
	if err := WritePending(stateDir, record); err != nil {
		t.Fatal(err)
	}
	if err := Swap(binary, digest); err != nil {
		t.Fatal(err)
	}
}

func TestTheSwapKeepsTheRunningBinaryAndPutsTheNewOneInOneRename(t *testing.T) {
	binary, stateDir := installed(t)
	before, err := os.Stat(binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteNext(binary, []byte("new agent")); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(binary + nextSuffix); err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("next: %v %v", info, err)
	}
	if err := LinkPrevious(binary); err != nil {
		t.Fatal(err)
	}
	previous, err := os.Stat(binary + previousSuffix)
	if err != nil || !os.SameFile(before, previous) {
		t.Fatal("previous is not a second name of the running binary")
	}
	digest, _ := FileSHA256(binary + nextSuffix)
	if err := Swap(binary, digest); err != nil {
		t.Fatal(err)
	}
	if content(t, binary) != "new agent" || content(t, binary+previousSuffix) != "old agent" {
		t.Fatal("the swap did not put the new binary in place")
	}
	// Run again once done: nothing to rename, the binary already holds the new digest.
	if err := Swap(binary, digest); err != nil {
		t.Fatalf("a resumed swap failed: %v", err)
	}
	if err := Swap(binary, "0000"); err == nil {
		t.Fatal("a swap with no .next and another binary reported done")
	}
	_ = stateDir
}

func TestASecondUpgradeReplacesTheOlderPreviousBinary(t *testing.T) {
	binary, stateDir := installed(t)
	swapped(t, binary, stateDir, "agent 2")
	if err := ClearPending(stateDir); err != nil {
		t.Fatal(err)
	}
	// A stale staging link from a crash is removed first.
	if err := os.WriteFile(binary+previousSuffix+".new", []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	swapped(t, binary, stateDir, "agent 3")
	if content(t, binary) != "agent 3" || content(t, binary+previousSuffix) != "agent 2" {
		t.Fatalf("binary %q, previous %q", content(t, binary), content(t, binary+previousSuffix))
	}
	if _, err := os.Stat(binary + previousSuffix + ".new"); !os.IsNotExist(err) {
		t.Fatal("the staging link is left behind")
	}
}

func TestTheGuardCountsStartsThenPutsThePreviousBinaryBack(t *testing.T) {
	binary, stateDir := installed(t)
	// Nothing pending: nothing done.
	if rolledBack, err := Guard(stateDir); rolledBack || err != nil {
		t.Fatalf("%v %v", rolledBack, err)
	}
	swapped(t, binary, stateDir, "new agent")
	for attempt := 1; attempt <= MaxAttempts; attempt++ {
		if rolledBack, err := Guard(stateDir); rolledBack || err != nil {
			t.Fatalf("attempt %d: %v %v", attempt, rolledBack, err)
		}
		record, _, _ := ReadPending(stateDir)
		if record.Attempts != attempt || content(t, binary) != "new agent" {
			t.Fatalf("attempt %d recorded as %d", attempt, record.Attempts)
		}
	}
	rolledBack, err := Guard(stateDir)
	if !rolledBack || err != nil {
		t.Fatalf("%v %v", rolledBack, err)
	}
	record, found, _ := ReadPending(stateDir)
	if !found || record.State != StateRolledBack || content(t, binary) != "old agent" {
		t.Fatalf("after the rollback: %+v %q", record, content(t, binary))
	}
	// Rolled back: later starts change nothing.
	if rolledBack, err := Guard(stateDir); rolledBack || err != nil {
		t.Fatalf("%v %v", rolledBack, err)
	}
}

func TestTheGuardReportsAMissingPreviousBinary(t *testing.T) {
	binary, stateDir := installed(t)
	swapped(t, binary, stateDir, "new agent")
	if err := os.Remove(binary + previousSuffix); err != nil {
		t.Fatal(err)
	}
	record, _, _ := ReadPending(stateDir)
	record.Attempts = MaxAttempts
	if err := WritePending(stateDir, record); err != nil {
		t.Fatal(err)
	}
	if rolledBack, err := Guard(stateDir); rolledBack || err == nil {
		t.Fatal("a rollback without a previous binary reported done")
	}
	if content(t, binary) != "new agent" {
		t.Fatal("the binary changed")
	}
}

func TestARecordThatNamesAnotherFileIsRefused(t *testing.T) {
	_, stateDir := installed(t)
	for _, bad := range []string{
		`{"binary":"relative/shipkeep-agent","state":"pending"}`,
		`{"binary":"/etc/passwd","state":"pending"}`,
		`{"binary":"/var/lib/shipkeep/bin/../../../usr/bin/shipkeep-agent","state":"pending"}`,
		`{"binary":"/var/lib/shipkeep/bin/shipkeep-agent","state":"done"}`,
		`{"binary":"/var/lib/shipkeep/bin/shipkeep-agent","state":"pending","attempts":-1}`,
		`not json`,
		`{"binary":"/var/lib/shipkeep/bin/shipkeep-agent","state":"pending","pad":"` + string(make([]byte, 5000)) + `"}`,
	} {
		if err := os.WriteFile(filepath.Join(stateDir, pendingFile), []byte(bad), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, found, err := ReadPending(stateDir); err == nil || found {
			t.Errorf("%.60q accepted", bad)
		}
		if rolledBack, err := Guard(stateDir); rolledBack || err == nil {
			t.Errorf("the guard acted on %.60q", bad)
		}
	}
	if err := WritePending(stateDir, Pending{Binary: "/tmp/evil", State: StatePending}); err == nil {
		t.Fatal("a record naming another binary was written")
	}
}
