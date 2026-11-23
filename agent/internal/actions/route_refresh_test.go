package actions

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

var routeKey = caddy.RouteID("api-prod")

func at(address string) map[string]string { return map[string]string{"sk-acme": address} }

func stoppedContainer(address string) fakeContainers {
	stopped := runningContainer(true, at(address))
	stopped.State.Running = false
	return fakeContainers{"sk-api-1": stopped}
}

// routedTo is a route the agent applied to dials, with weights when given.
func routedTo(dials []string, weights ...int) caddy.Route {
	upstreams := make([]caddy.Upstream, 0, len(dials))
	for _, dial := range dials {
		upstreams = append(upstreams, caddy.Upstream{Dial: dial})
	}
	return caddy.Route{ID: routeKey, Handle: []caddy.Handler{proxyHandler(upstreams, weights, len(weights) > 0)}}
}

// recordedRoute is a router holding route, and the record the agent keeps of it.
func recordedRoute(route caddy.Route, record journal.RouteRecord) (*fakeRouter, *fakeRecords) {
	records := &fakeRecords{routes: map[string]journal.RouteRecord{routeKey: record}}
	router := &fakeRouter{routes: map[string]caddy.Route{routeKey: route}, book: &RouteBook{Store: records}}
	return router, records
}

// oneContainer is the record of a route to sk-api-1 that the agent applied at 172.18.0.5.
func oneContainer() journal.RouteRecord {
	return journal.RouteRecord{
		Upstreams: []journal.RouteUpstream{{Container: "sk-api-1", Port: 8080, Weight: 1}},
		Written:   [][]string{{"172.18.0.5:8080"}},
	}
}

func refresh(t *testing.T, router *fakeRouter, containers Containers) error {
	t.Helper()
	return RouteRefresher{Router: router, Containers: containers, Book: router.book}.Refresh(context.Background())
}

func dialsOf(router *fakeRouter) []string {
	router.mu.Lock()
	defer router.mu.Unlock()
	return dials(router.routes[routeKey])
}

func TestRoutesRecordTheirContainersBeforeCaddyGetsThem(t *testing.T) {
	records := &fakeRecords{}
	router := &fakeRouter{routes: map[string]caddy.Route{}, book: &RouteBook{Store: records}, containers: fakeContainers{
		"sk-api-1": runningContainer(true, at("172.18.0.5")),
	}}
	var slept []time.Duration
	route := validRoute("")
	route.Upstreams = []*agentv1.Upstream{{Container: "sk-api-1", Port: 8080, Weight: 3}, {Address: "10.210.0.4:8080"}}
	// The record is written ahead: when Caddy gets the route, it is already there.
	router.onWrite = func() {
		if record := records.record(routeKey); len(record.Written) != 1 {
			t.Errorf("Caddy written before the record: %+v", record)
		}
	}
	if !succeeded(routeRequest(t, router, &slept, upsert(route))) {
		t.Fatal("route not applied")
	}
	want := journal.RouteRecord{
		Upstreams: []journal.RouteUpstream{{Container: "sk-api-1", Port: 8080, Weight: 3}, {Address: "10.210.0.4:8080", Weight: 1}},
		Written:   [][]string{{"172.18.0.5:8080", "10.210.0.4:8080"}},
	}
	if got := records.record(routeKey); !reflect.DeepEqual(got, want) {
		t.Fatalf("recorded %+v, want %+v", got, want)
	}
	router.onWrite = nil
	maintenance := validRoute("")
	maintenance.Upstreams, maintenance.Maintenance = nil, true
	if !succeeded(routeRequest(t, router, &slept, upsert(maintenance))) || len(records.routes) != 0 {
		t.Fatalf("the maintenance page kept a record: %v", records.routes)
	}
	if !succeeded(routeRequest(t, router, &slept, upsert(route))) || len(records.routes) != 1 {
		t.Fatal("route not recorded again")
	}
	remove := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: "api-prod"}}}
	if !succeeded(routeRequest(t, router, &slept, remove)) || len(records.routes) != 0 {
		t.Fatalf("a removed route kept its record: %v", records.routes)
	}
}

// A route Caddy refused keeps the old one in place, which holds none of the recorded dials: the
// refresh leaves it alone instead of giving it the new route's upstreams.
func TestARefusedRouteIsNotCompletedByTheRefresh(t *testing.T) {
	router, records := recordedRoute(routedTo([]string{"172.18.0.5:8080"}), oneContainer())
	router.containers = fakeContainers{
		"sk-api-1": runningContainer(true, at("172.18.0.5")),
		"sk-api-2": runningContainer(true, at("172.18.0.6")),
	}
	router.failUpsert = true
	route := validRoute("")
	route.Upstreams = []*agentv1.Upstream{{Container: "sk-api-2", Port: 8080}}
	var slept []time.Duration
	if succeeded(routeRequest(t, router, &slept, upsert(route))) {
		t.Fatal("refused route reported applied")
	}
	if err := refresh(t, router, router.containers); err != nil {
		t.Fatal(err)
	}
	if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.5:8080"}) {
		t.Fatalf("the refresh changed the route Caddy kept: %v (record %+v)", got, records.record(routeKey))
	}
	// The record describes the route Caddy kept again, so that route still follows its container.
	if record := records.record(routeKey); !reflect.DeepEqual(record, oneContainer()) {
		t.Fatalf("record after a refused upsert: %+v, want the one before it", record)
	}
	if err := refresh(t, router, fakeContainers{"sk-api-1": runningContainer(true, at("172.18.0.9"))}); err != nil {
		t.Fatal(err)
	}
	if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.9:8080"}) {
		t.Fatalf("the route Caddy kept no longer follows its container: %v", got)
	}

	// A refused first route leaves no record behind.
	router.routes, records.routes = map[string]caddy.Route{}, map[string]journal.RouteRecord{}
	if succeeded(routeRequest(t, router, &slept, upsert(route))) {
		t.Fatal("refused route reported applied")
	}
	if len(records.routes) != 0 {
		t.Fatalf("a refused first route kept a record: %v", records.routes)
	}
}

// The same addresses in another order still carry their own weights: the refresh compares the
// weights Caddy holds, not only the dials.
func TestRouteRefresherRewritesWeightsThatMovedWithTheirAddresses(t *testing.T) {
	record := journal.RouteRecord{
		Upstreams: []journal.RouteUpstream{
			{Container: "sk-api-1", Port: 8080, Weight: 99},
			{Container: "sk-api-2", Port: 8080, Weight: 1},
			{Container: "sk-api-3", Port: 8080, Weight: 1},
		},
		// sk-api-2 was down: the route holds sk-api-1 and sk-api-3.
		Written: [][]string{{"172.18.0.5:8080", "172.18.0.7:8080"}},
	}
	router, _ := recordedRoute(routedTo([]string{"172.18.0.5:8080", "172.18.0.7:8080"}, 99, 1), record)
	// sk-api-1 is gone, and sk-api-2 came back at the address sk-api-1 had.
	stopped := runningContainer(true, at("172.18.0.9"))
	stopped.State.Running = false
	containers := fakeContainers{
		"sk-api-1": stopped,
		"sk-api-2": runningContainer(true, at("172.18.0.5")),
		"sk-api-3": runningContainer(true, at("172.18.0.7")),
	}
	if err := refresh(t, router, containers); err != nil {
		t.Fatal(err)
	}
	router.mu.Lock()
	handler := router.routes[routeKey].Handle[0]
	router.mu.Unlock()
	if got := installedWeights(handler); !slices.Equal(got, []int{1, 1}) {
		t.Fatalf("weights %v: sk-api-2 serves the first address with sk-api-1's weight", got)
	}
}

func TestARouteKeepsItsRecordUntilCaddyRemovesIt(t *testing.T) {
	router, records := recordedRoute(routedTo([]string{"172.18.0.5:8080"}), oneContainer())
	router.failRemove = true
	remove := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: "api-prod"}}}
	var slept []time.Duration
	if succeeded(routeRequest(t, router, &slept, remove)) {
		t.Fatal("failed removal reported done")
	}
	if _, kept := records.routes[routeKey]; !kept {
		t.Fatal("record forgotten while Caddy still holds the route")
	}
	// The route stays, and keeps following its container.
	if err := refresh(t, router, fakeContainers{"sk-api-1": runningContainer(true, at("172.18.0.9"))}); err != nil {
		t.Fatal(err)
	}
	if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.9:8080"}) {
		t.Fatalf("route not followed after a failed removal: %v", got)
	}
}

// A container that came back at another address gets its traffic back; a route written by
// anything but the agent is left alone (ADR 0017, PLAN M1.6).
func TestRouteRefresherFollowsAContainerThatMoved(t *testing.T) {
	moved := fakeContainers{"sk-api-1": runningContainer(true, at("172.18.0.9"))}
	router, records := recordedRoute(routedTo([]string{"172.18.0.5:8080"}), oneContainer())
	if err := refresh(t, router, moved); err != nil {
		t.Fatal(err)
	}
	if got, record := dialsOf(router), records.record(routeKey); !slices.Equal(got, []string{"172.18.0.9:8080"}) || !reflect.DeepEqual(record.Written, [][]string{{"172.18.0.9:8080"}}) {
		t.Fatalf("route not moved: %v, recorded %+v", got, record)
	}

	// Not a list the agent wrote: left to whoever wrote it.
	router, _ = recordedRoute(routedTo([]string{"172.18.0.7:8080"}), oneContainer())
	if err := refresh(t, router, moved); err != nil {
		t.Fatal(err)
	}
	if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.7:8080"}) {
		t.Fatalf("a route the agent did not write was overwritten: %v", got)
	}
}

// Two replicas exchange their addresses across a restart: each keeps its weight.
func TestRouteRefresherFollowsReplicasThatSwappedAddresses(t *testing.T) {
	record := journal.RouteRecord{
		Upstreams: []journal.RouteUpstream{{Container: "sk-api-1", Port: 8080, Weight: 99}, {Container: "sk-api-2", Port: 8080, Weight: 1}},
		Written:   [][]string{{"172.18.0.5:8080", "172.18.0.9:8080"}},
	}
	router, _ := recordedRoute(routedTo([]string{"172.18.0.5:8080", "172.18.0.9:8080"}, 99, 1), record)
	swapped := fakeContainers{
		"sk-api-1": runningContainer(true, at("172.18.0.9")),
		"sk-api-2": runningContainer(true, at("172.18.0.5")),
	}
	if err := refresh(t, router, swapped); err != nil {
		t.Fatal(err)
	}
	want := routedTo([]string{"172.18.0.9:8080", "172.18.0.5:8080"}, 99, 1)
	if got := router.routes[routeKey]; !reflect.DeepEqual(got.Handle, want.Handle) {
		t.Fatalf("swap not followed: %+v", got.Handle)
	}
}

// A container that does not run gets no traffic: its old address may be another container's now.
// With none left, the route answers 503, and it proxies again once the container runs.
func TestRouteRefresherSendsNothingToAStoppedContainer(t *testing.T) {
	record := journal.RouteRecord{
		Upstreams: []journal.RouteUpstream{{Container: "sk-api-1", Port: 8080, Weight: 1}, {Container: "sk-api-2", Port: 8080, Weight: 1}},
		Written:   [][]string{{"172.18.0.5:8080", "172.18.0.6:8080"}},
	}
	router, _ := recordedRoute(routedTo([]string{"172.18.0.5:8080", "172.18.0.6:8080"}), record)
	containers := fakeContainers{"sk-api-2": runningContainer(true, at("172.18.0.6"))}
	if err := refresh(t, router, containers); err != nil {
		t.Fatal(err)
	}
	if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.6:8080"}) {
		t.Fatalf("traffic still sent to the stopped container's address: %v", got)
	}
	// Neither runs; one is not even managed any more under that name.
	containers = stoppedContainer("172.18.0.5")
	containers["sk-api-2"] = runningContainer(false, at("172.18.0.6"))
	if err := refresh(t, router, containers); err != nil {
		t.Fatal(err)
	}
	if handler := router.routes[routeKey].Handle[0]; !caddy.IsUnavailable(handler) {
		t.Fatalf("a route with no running container still proxies: %+v", handler)
	}
	containers = fakeContainers{"sk-api-1": runningContainer(true, at("172.18.0.8"))}
	if err := refresh(t, router, containers); err != nil {
		t.Fatal(err)
	}
	if got := router.routes[routeKey].Handle[0]; got.Handler != "reverse_proxy" || !slices.Equal(dialsOf(router), []string{"172.18.0.8:8080"}) {
		t.Fatalf("route not back on its running container: %+v", got)
	}
}

// When Docker does not answer, nothing is dropped on a guess.
func TestRouteRefresherChangesNothingWithoutDocker(t *testing.T) {
	router, _ := recordedRoute(routedTo([]string{"172.18.0.5:8080"}), oneContainer())
	if err := refresh(t, router, downContainers{}); err == nil {
		t.Fatal("no error reported")
	}
	if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.5:8080"}) {
		t.Fatalf("route changed without Docker: %v", got)
	}
	// Two upstreams that would share an address: the route is left as it is.
	record := oneContainer()
	record.Upstreams = append(record.Upstreams, journal.RouteUpstream{Address: "172.18.0.9:8080", Weight: 1})
	record.Written = [][]string{{"172.18.0.5:8080", "172.18.0.9:8080"}}
	router, _ = recordedRoute(routedTo([]string{"172.18.0.5:8080", "172.18.0.9:8080"}), record)
	if err := refresh(t, router, fakeContainers{"sk-api-1": runningContainer(true, at("172.18.0.9"))}); err == nil {
		t.Fatal("duplicate address not reported")
	}
	if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.5:8080", "172.18.0.9:8080"}) {
		t.Fatalf("route given a duplicate address: %v", got)
	}
}

// Whichever write fails, the next passes bring the route and its record back together, and the
// route keeps following its container.
func TestRouteRefresherRecoversFromAFailedWrite(t *testing.T) {
	moved := func(address string) fakeContainers {
		return fakeContainers{"sk-api-1": runningContainer(true, at(address))}
	}
	cases := map[string]func(*fakeRouter, *fakeRecords){
		"the record written ahead": func(_ *fakeRouter, records *fakeRecords) { records.failSet = []bool{true} },
		"the write to Caddy":       func(router *fakeRouter, _ *fakeRecords) { router.failUpdate = true },
		"the record after it":      func(_ *fakeRouter, records *fakeRecords) { records.failSet = []bool{false, true} },
	}
	for name, fail := range cases {
		t.Run(name, func(t *testing.T) {
			router, records := recordedRoute(routedTo([]string{"172.18.0.5:8080"}), oneContainer())
			fail(router, records)
			if err := refresh(t, router, moved("172.18.0.9")); err == nil {
				t.Fatal("failure not reported")
			}
			router.failUpdate = false
			if err := refresh(t, router, moved("172.18.0.9")); err != nil {
				t.Fatal(err)
			}
			if got, record := dialsOf(router), records.record(routeKey); !slices.Equal(got, []string{"172.18.0.9:8080"}) || !reflect.DeepEqual(record.Written, [][]string{{"172.18.0.9:8080"}}) {
				t.Fatalf("not recovered: route %v, record %+v", got, record)
			}
			// It moves again later: the record still matches the route.
			if err := refresh(t, router, moved("172.18.0.3")); err != nil {
				t.Fatal(err)
			}
			if got := dialsOf(router); !slices.Equal(got, []string{"172.18.0.3:8080"}) {
				t.Fatalf("route no longer followed: %v", got)
			}
		})
	}
}

// The route actions and the refresher write a route and its record under one lock, so that an
// action never lands between the refresh's route write and its record write.
func TestRouteWritesAndTheirRecordsShareOneLock(t *testing.T) {
	router, _ := recordedRoute(routedTo([]string{"172.18.0.5:8080"}), oneContainer())
	router.containers = fakeContainers{"sk-api-1": runningContainer(true, at("172.18.0.9"))}
	writes := 0
	router.onWrite = func() {
		writes++
		if router.book.mu.TryLock() {
			router.book.mu.Unlock()
			t.Error("a route was written without the book's lock")
		}
	}
	if err := refresh(t, router, router.containers); err != nil {
		t.Fatal(err)
	}
	route := validRoute("")
	route.Upstreams = []*agentv1.Upstream{{Container: "sk-api-1", Port: 8080}}
	var slept []time.Duration
	if !succeeded(routeRequest(t, router, &slept, upsert(route))) {
		t.Fatal("route not applied")
	}
	remove := &agentv1.ActionRequest{Action: &agentv1.ActionRequest_RemoveRoute{RemoveRoute: &agentv1.RemoveRoute{RouteId: "api-prod"}}}
	if !succeeded(routeRequest(t, router, &slept, remove)) {
		t.Fatal("route not removed")
	}
	if writes < 3 {
		t.Fatalf("only %d writes seen", writes)
	}
}
