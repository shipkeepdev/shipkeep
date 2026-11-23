package journal

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
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

func TestRouteRecordsAreRecordedReplacedAndForgotten(t *testing.T) {
	store, err := Open(t.Context(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close() //nolint:errcheck // test cleanup
	ctx, now := t.Context(), time.Unix(1_700_000_000, 0)
	record := RouteRecord{
		Upstreams: []RouteUpstream{{Container: "sk-api-1", Port: 8080, Weight: 1}, {Address: "10.210.0.4:8080", Weight: 3}},
		Written:   [][]string{{"172.18.0.5:8080", "10.210.0.4:8080"}},
	}
	if err := store.SetRouteRecord(ctx, "sk-route-api", record, now); err != nil {
		t.Fatal(err)
	}
	// Written ahead of a change: two lists, and the 503 answer, which holds none.
	record.Written = [][]string{{"172.18.0.5:8080", "10.210.0.4:8080"}, {}}
	if err := store.SetRouteRecord(ctx, "sk-route-api", record, now); err != nil {
		t.Fatal(err)
	}
	got, found, err := store.RouteRecord(ctx, "sk-route-api")
	if err != nil || !found || !reflect.DeepEqual(got, record) {
		t.Fatalf("record not replaced: %+v %v %v", got, found, err)
	}
	if routes, err := store.RecordedRoutes(ctx); err != nil || !slices.Equal(routes, []string{"sk-route-api"}) {
		t.Fatalf("recorded routes %v %v", routes, err)
	}
	if err := store.ClearRouteRecord(ctx, "sk-route-api"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := store.RouteRecord(ctx, "sk-route-api"); found {
		t.Fatal("record kept after it was forgotten")
	}
	one := func(upstream RouteUpstream) RouteRecord {
		return RouteRecord{Upstreams: []RouteUpstream{upstream}, Written: [][]string{{"172.18.0.5:8080"}}}
	}
	for name, bad := range map[string]RouteRecord{
		"no upstream":       {Written: [][]string{{}}},
		"no container":      one(RouteUpstream{Address: "10.210.0.4:8080", Weight: 1}),
		"bad container":     one(RouteUpstream{Container: "../x", Port: 80, Weight: 1}),
		"no port":           one(RouteUpstream{Container: "sk-a", Weight: 1}),
		"both forms":        one(RouteUpstream{Container: "sk-a", Port: 80, Address: "10.0.0.1:80", Weight: 1}),
		"no weight":         one(RouteUpstream{Container: "sk-a", Port: 80}),
		"weight too high":   one(RouteUpstream{Container: "sk-a", Port: 80, Weight: 101}),
		"nothing written":   {Upstreams: one(RouteUpstream{Container: "sk-a", Port: 80, Weight: 1}).Upstreams},
		"three lists":       {Upstreams: one(RouteUpstream{Container: "sk-a", Port: 80, Weight: 1}).Upstreams, Written: [][]string{{}, {}, {}}},
		"empty dial":        {Upstreams: one(RouteUpstream{Container: "sk-a", Port: 80, Weight: 1}).Upstreams, Written: [][]string{{""}}},
		"oversized address": one(RouteUpstream{Address: strings.Repeat("1", 65), Weight: 1}),
	} {
		if err := store.SetRouteRecord(ctx, "sk-route-api", bad, now); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if err := store.SetRouteRecord(ctx, "../route", record, now); err == nil {
		t.Error("invalid route id accepted")
	}
}
