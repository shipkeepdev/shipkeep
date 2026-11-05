package journal

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

func TestLocalStatePersistsWithoutSecretValues(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	sensitive := []byte("test-private-value-must-never-reach-sqlite")
	spec := &agentv1.ContainerSpec{Name: "sk-app", Secrets: []*agentv1.SecretEnv{{Name: "DATABASE_PASSWORD", Version: 3, Value: sensitive}}}
	for range 20 {
		if err := store.PutDesired(t.Context(), "app", 2, spec); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(spec.Secrets[0].Value, sensitive) {
		t.Fatal("persistence mutated the execution payload")
	}
	if err := store.PutDesired(t.Context(), "app", 1, spec); !errors.Is(err, ErrConflict) {
		t.Fatal("stale desired state accepted")
	}
	changed := &agentv1.ContainerSpec{Name: "sk-other"}
	if err := store.PutDesired(t.Context(), "app", 2, changed); !errors.Is(err, ErrConflict) {
		t.Fatal("same-version replacement accepted")
	}
	now := time.Now().Truncate(time.Millisecond)
	if err := store.Observe(t.Context(), "app", &agentv1.ContainerStatus{Name: "sk-app", Healthy: true}, now); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRouting(t.Context(), &agentv1.RoutingTable{Version: 4}); err != nil {
		t.Fatal(err)
	}
	if err := store.PutRouting(t.Context(), &agentv1.RoutingTable{Version: 3}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale routing accepted")
	}
	if err := store.PutLease(t.Context(), 2, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.PutLease(t.Context(), 1, now.Add(time.Hour)); !errors.Is(err, ErrConflict) {
		t.Fatal("epoch rollback accepted")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	cached, version, err := store.Desired(t.Context(), "app")
	if err != nil || version != 2 || len(cached.Secrets) != 1 || cached.Secrets[0].Version != 3 || len(cached.Secrets[0].Value) != 0 {
		t.Fatal("secret references not preserved safely")
	}
	observed, at, err := store.Actual(t.Context(), "app")
	if err != nil || !observed.Healthy || !at.Equal(now) {
		t.Fatal("observed state missing")
	}
	routing, err := store.Routing(t.Context())
	if err != nil || routing.Version != 4 {
		t.Fatal("routing snapshot missing")
	}
	epoch, expiry, err := store.Lease(t.Context())
	if err != nil || epoch != 2 || !expiry.Equal(now.Add(time.Minute)) {
		t.Fatal("lease missing")
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(dir, file.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(data, sensitive) {
			t.Fatal("secret value persisted in SQLite or its sidecars")
		}
	}
}

func TestConfirmationConsumptionIsSingleUseAndDurable(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	expiry := now.Add(time.Minute)
	var winners atomic.Int32
	var workers sync.WaitGroup
	for range 10 {
		workers.Go(func() {
			used, err := store.ConsumeConfirmation(t.Context(), "confirmation-1", expiry, now)
			if err != nil {
				t.Error(err)
			}
			if used {
				winners.Add(1)
			}
		})
	}
	workers.Wait()
	if winners.Load() != 1 {
		t.Fatal("confirmation consumed more than once")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	used, err := store.ConsumeConfirmation(t.Context(), "confirmation-1", expiry, now)
	if err != nil || used {
		t.Fatal("confirmation replay accepted after restart")
	}
	for _, expires := range []time.Time{now, now.Add(-time.Second), now.Add(7 * time.Minute)} {
		if _, err := store.ConsumeConfirmation(t.Context(), "invalid", expires, now); err == nil {
			t.Fatal("invalid confirmation validity accepted")
		}
	}
	// A node whose clock runs 30 s behind the control plane sees 5 min 30 s of validity left.
	skewed, err := store.ConsumeConfirmation(t.Context(), "confirmation-2", now.Add(5*time.Minute+30*time.Second), now)
	if err != nil || !skewed {
		t.Fatalf("confirmation from a slightly faster control plane rejected: used=%v err=%v", skewed, err)
	}
}

func TestLocalStateRejectsOversizedAndStaleObservations(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	if err := store.PutDesired(t.Context(), "app", 1, &agentv1.ContainerSpec{Secrets: []*agentv1.SecretEnv{{Value: make([]byte, 1<<20)}}}); err == nil {
		t.Fatal("oversized state accepted")
	}
	now := time.Now()
	if err := store.Observe(t.Context(), "app", &agentv1.ContainerStatus{}, now); err != nil {
		t.Fatal(err)
	}
	if err := store.Observe(t.Context(), "app", &agentv1.ContainerStatus{}, now.Add(-time.Second)); !errors.Is(err, ErrConflict) {
		t.Fatal("stale observation accepted")
	}
}

func TestLocalStateUpgradePreservesOperations(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Begin(t.Context(), request()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(t.Context(), "DROP TABLE desired; DROP TABLE actual; DROP TABLE routing; DROP TABLE lease; DROP TABLE used_confirmations; PRAGMA user_version=1;"); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	operations, err := store.Unfinished(t.Context())
	if err != nil || len(operations) != 1 {
		t.Fatal("schema upgrade lost operation intent")
	}
	if err := store.PutRouting(t.Context(), &agentv1.RoutingTable{Version: 1}); err != nil {
		t.Fatal(err)
	}
}
