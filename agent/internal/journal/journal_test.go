package journal

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func request() Request {
	return Request{ID: "0192f0c0-0000-7000-8000-000000000001", Key: "deployment-step-1", Kind: "create_container", PayloadHash: sha256.Sum256([]byte("private payload never persisted"))}
}

func TestJournalPersistsAndRejectsConflictingReplays(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Begin(t.Context(), request())
	if err != nil {
		t.Fatal(err)
	}
	next := first
	next.State = Running
	next.Step = "create"
	next.Attempts = 1
	running, err := store.Advance(t.Context(), first, next)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Advance(t.Context(), first, next); !errors.Is(err, ErrConflict) {
		t.Fatal("stale writer accepted")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	replay, err := store.Begin(t.Context(), request())
	if err != nil || replay.State != Running || replay.Step != "create" {
		t.Fatalf("resume state missing: %v", err)
	}
	if replay.Revision != running.Revision {
		t.Fatal("revision lost")
	}
	conflict := request()
	conflict.PayloadHash = sha256.Sum256([]byte("different"))
	if _, err := store.Begin(t.Context(), conflict); !errors.Is(err, ErrConflict) {
		t.Fatal("different payload accepted for the same key")
	}
	pending, err := store.Unfinished(t.Context())
	if err != nil || len(pending) != 1 {
		t.Fatal("unfinished operation missing")
	}
	contents, err := os.ReadFile(filepath.Join(dir, "agent.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(contents, []byte("private payload")) {
		t.Fatal("payload written to SQLite")
	}
}

func TestJournalSingleWriterAndIdempotentConcurrency(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	if second, err := Open(t.Context(), dir); err == nil {
		_ = second.Close()
		t.Fatal("two agent processes can own the journal")
	}
	var workers sync.WaitGroup
	for range 10 {
		workers.Go(func() {
			if _, err := store.Begin(t.Context(), request()); err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	operations, err := store.Unfinished(t.Context())
	if err != nil || len(operations) != 1 {
		t.Fatal("duplicate operation created")
	}
	info, err := os.Stat(filepath.Join(dir, "agent.sqlite"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("journal is not private")
	}
}

func TestJournalRejectsInvalidStatesAndInput(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	for _, mutate := range []func(*Request){func(r *Request) { r.ID = "../../bad" }, func(r *Request) { r.Key = "" }, func(r *Request) { r.Kind = "sh -c evil" }} {
		bad := request()
		mutate(&bad)
		if _, err := store.Begin(t.Context(), bad); err == nil {
			t.Fatal("invalid metadata accepted")
		}
	}
	op, err := store.Begin(t.Context(), request())
	if err != nil {
		t.Fatal(err)
	}
	invalid := op
	invalid.State = Succeeded
	if _, err := store.Advance(t.Context(), op, invalid); err == nil {
		t.Fatal("pending skipped execution")
	}
	invalid = op
	invalid.State = Running
	invalid.Step = "a secret error message"
	if _, err := store.Advance(t.Context(), op, invalid); err == nil {
		t.Fatal("unbounded metadata accepted")
	}
}
