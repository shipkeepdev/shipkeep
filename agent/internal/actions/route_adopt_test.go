package actions

import (
	"context"
	"errors"
	"maps"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
)

// routeList is Caddy's list of routes, in order.
type routeList []caddy.Route

func (l routeList) Routes(context.Context) ([]caddy.Route, error) { return l, nil }

// inventory is Docker's managed containers, by name; each container's id is its name.
type inventory struct{ fakeContainers }

func (i inventory) ManagedContainers(context.Context) ([]docker.ContainerSummary, error) {
	summaries := make([]docker.ContainerSummary, 0, len(i.fakeContainers))
	for _, name := range slices.Sorted(maps.Keys(i.fakeContainers)) {
		summaries = append(summaries, docker.ContainerSummary{ID: name, Names: []string{"/" + name}})
	}
	return summaries, nil
}

// downInventory is a Docker daemon that lists containers, then stops answering.
type downInventory struct{ inventory }

func (downInventory) Container(context.Context, string) (docker.Container, error) {
	return docker.Container{}, errors.New("docker GET: connection refused")
}

// appContainer is a running container of application at address on sk-acme.
func appContainer(application, address string) docker.Container {
	container := runningContainer(true, at(address))
	container.Config.Labels[ApplicationLabel] = application
	return container
}

// legacyRoute is the route of the api-prod application as an agent of 0.1.0-alpha.3 wrote it,
// without a record.
func legacyRoute(dials []string, weights ...int) caddy.Route {
	route := routedTo(dials, weights...)
	route.ID = caddy.RouteID("api-prod")
	return route
}

func adopt(t *testing.T, routes routeList, containers Inventory, records *fakeRecords) Adoption {
	t.Helper()
	adoption, err := AdoptRoutes(context.Background(), routes, containers, &RouteBook{Store: records}, time.Unix(1_800_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	return adoption
}

func TestAnAdoptedRouteFollowsItsContainerWhenDockerShufflesAddresses(t *testing.T) {
	route := legacyRoute([]string{"172.18.0.5:8080"})
	containers := inventory{fakeContainers{"sk-api-1": appContainer("api-prod", "172.18.0.5"), "sk-web-1": appContainer("web-prod", "172.18.0.6")}}
	records := &fakeRecords{}
	adoption := adopt(t, routeList{route}, containers, records)
	if !slices.Equal(adoption.Adopted, []string{"api-prod"}) || len(adoption.Refused) != 0 {
		t.Fatalf("adoption = %+v", adoption)
	}
	want := journal.RouteRecord{Upstreams: []journal.RouteUpstream{{Container: "sk-api-1", Port: 8080, Weight: 1}}, Written: [][]string{{"172.18.0.5:8080"}}}
	if got := records.record(route.ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("record = %+v, want %+v", got, want)
	}
	// Docker restarts: the two containers swap addresses. The route follows its own container.
	router := &fakeRouter{routes: map[string]caddy.Route{route.ID: route}, book: &RouteBook{Store: records}}
	swapped := fakeContainers{"sk-api-1": appContainer("api-prod", "172.18.0.6"), "sk-web-1": appContainer("web-prod", "172.18.0.5")}
	if err := refresh(t, router, swapped); err != nil {
		t.Fatal(err)
	}
	if got := dials(router.routes[route.ID]); !slices.Equal(got, []string{"172.18.0.6:8080"}) {
		t.Fatalf("dials after the restart = %v, want the API container's new address", got)
	}
}

func TestAWeightedRouteIsAdoptedWithItsWeights(t *testing.T) {
	route := legacyRoute([]string{"172.18.0.5:8080", "172.18.0.7:8080"}, 90, 10)
	containers := inventory{fakeContainers{"sk-api-r1-1": appContainer("api-prod", "172.18.0.5"), "sk-api-r2-1": appContainer("api-prod", "172.18.0.7")}}
	records := &fakeRecords{}
	adopt(t, routeList{route}, containers, records)
	want := []journal.RouteUpstream{{Container: "sk-api-r1-1", Port: 8080, Weight: 90}, {Container: "sk-api-r2-1", Port: 8080, Weight: 10}}
	if got := records.record(route.ID).Upstreams; !reflect.DeepEqual(got, want) {
		t.Fatalf("upstreams = %+v, want %+v", got, want)
	}
}

func TestARouteWhoseTrafficGoesElsewhereIsNotAdopted(t *testing.T) {
	stopped := appContainer("api-prod", "172.18.0.9")
	stopped.State.Running = false
	unlabelled := runningContainer(true, at("172.18.0.8"))
	cases := map[string]struct {
		dials      []string
		containers fakeContainers
		reason     string
	}{
		// A restart since the route was written gave its address to another application.
		"another application's container": {[]string{"172.18.0.5:8080"}, fakeContainers{"sk-web-1": appContainer("web-prod", "172.18.0.5")}, AdoptOtherApplication},
		"one of two upstreams elsewhere":  {[]string{"172.18.0.5:8080", "172.18.0.6:8080"}, fakeContainers{"sk-api-1": appContainer("api-prod", "172.18.0.5"), "sk-web-1": appContainer("web-prod", "172.18.0.6")}, AdoptOtherApplication},
		"a container of no application":   {[]string{"172.18.0.8:8080"}, fakeContainers{"sk-other-1": unlabelled}, AdoptOtherApplication},
		"two containers at one address":   {[]string{"172.18.0.5:8080"}, fakeContainers{"sk-api-1": appContainer("api-prod", "172.18.0.5"), "sk-api-2": appContainer("api-prod", "172.18.0.5")}, AdoptOtherApplication},
		"a stopped container":             {[]string{"172.18.0.9:8080"}, fakeContainers{"sk-api-1": stopped}, AdoptNoContainer},
		"an address nobody has":           {[]string{"172.18.0.5:8080"}, fakeContainers{}, AdoptNoContainer},
		// Only Shipkeep containers count, by name: anything else at that address is not followed.
		"a container named like no resource": {[]string{"172.18.0.5:8080"}, fakeContainers{"api;rm -rf /": appContainer("api-prod", "172.18.0.5")}, AdoptNoContainer},
		"an unmanaged container": {[]string{"172.18.0.5:8080"}, fakeContainers{"sk-api-1": func() docker.Container {
			c := appContainer("api-prod", "172.18.0.5")
			delete(c.Config.Labels, docker.ManagedLabel)
			return c
		}()}, AdoptNoContainer},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			route := legacyRoute(tc.dials)
			records := &fakeRecords{}
			adoption := adopt(t, routeList{route}, inventory{tc.containers}, records)
			if adoption.Refused["api-prod"] != tc.reason || len(adoption.Adopted) != 0 {
				t.Fatalf("adoption = %+v, want refused with %s", adoption, tc.reason)
			}
			if _, found, _ := records.RouteRecord(context.Background(), route.ID); found {
				t.Fatal("a route that could not be tied to its containers was recorded")
			}
		})
	}
}

func TestARouteNoAgentWritesIsNotAdopted(t *testing.T) {
	api := fakeContainers{"sk-api-1": appContainer("api-prod", "172.18.0.5")}
	weighted := func(weights ...int) caddy.Route {
		route := legacyRoute([]string{"172.18.0.5:8080"})
		route.Handle[0].LoadBalancing = &caddy.LoadBalancing{SelectionPolicy: map[string]any{"policy": "weighted_round_robin", "weights": weights}}
		return route
	}
	for name, route := range map[string]caddy.Route{
		"a host name":            legacyRoute([]string{"localhost:8080"}),
		"a public address":       legacyRoute([]string{"8.8.8.8:8080"}),
		"loopback":               legacyRoute([]string{"127.0.0.1:8080"}),
		"port zero":              legacyRoute([]string{"172.18.0.5:0"}),
		"no port":                legacyRoute([]string{"172.18.0.5"}),
		"a padded address":       legacyRoute([]string{" 172.18.0.5:8080"}),
		"a non-canonical form":   legacyRoute([]string{"172.018.0.5:8080"}),
		"a placeholder":          legacyRoute([]string{"{http.request.host}:8080"}),
		"the same address twice": legacyRoute([]string{"172.18.0.5:8080", "172.18.0.5:8080"}),
		"no upstream":            legacyRoute(nil),
		"a weight of zero":       weighted(0),
		"a weight over 100":      weighted(101),
		"missing weights":        weighted(),
	} {
		t.Run(name, func(t *testing.T) {
			records := &fakeRecords{}
			adoption := adopt(t, routeList{route}, inventory{api}, records)
			if adoption.Refused["api-prod"] != AdoptUnexpected || len(records.routes) != 0 {
				t.Fatalf("adoption = %+v, records = %+v", adoption, records.routes)
			}
		})
	}
}

func TestAdoptionLeavesRoutesThatAreNotLegacyApplicationRoutes(t *testing.T) {
	api := inventory{fakeContainers{"sk-api-1": appContainer("api-prod", "172.18.0.5")}}
	unavailable := legacyRoute(nil)
	unavailable.Handle = []caddy.Handler{caddy.UnavailableHandler()}
	controlPlane := routedTo([]string{"172.18.0.5:8080"})
	controlPlane.ID = "shipkeep-control-plane"
	traversal := routedTo([]string{"172.18.0.5:8080"})
	traversal.ID = caddy.RouteID("../api-prod")
	records := &fakeRecords{}
	adoption := adopt(t, routeList{unavailable, controlPlane, traversal}, api, records)
	if len(adoption.Adopted)+len(adoption.Followed)+len(adoption.Refused) != 0 || len(records.routes) != 0 {
		t.Fatalf("adoption = %+v, records = %+v", adoption, records.routes)
	}
}

func TestARouteAlreadyFollowedKeepsItsRecord(t *testing.T) {
	route := legacyRoute([]string{"172.18.0.5:8080"})
	record := oneContainer()
	records := &fakeRecords{routes: map[string]journal.RouteRecord{route.ID: record}}
	// Its container already moved: the record, not the address, says which container it follows.
	adoption := adopt(t, routeList{route}, inventory{fakeContainers{"sk-web-1": appContainer("web-prod", "172.18.0.5")}}, records)
	if !slices.Equal(adoption.Followed, []string{"api-prod"}) || len(adoption.Refused) != 0 || !reflect.DeepEqual(records.record(route.ID), record) {
		t.Fatalf("adoption = %+v, record = %+v", adoption, records.record(route.ID))
	}
}

func TestARouteRewrittenAfterItsRecordIsAdoptedAgain(t *testing.T) {
	// An older agent ran after the record was made and moved the route to a new release.
	route := legacyRoute([]string{"172.18.0.7:8080"})
	records := &fakeRecords{routes: map[string]journal.RouteRecord{route.ID: oneContainer()}}
	adoption := adopt(t, routeList{route}, inventory{fakeContainers{"sk-api-r2-1": appContainer("api-prod", "172.18.0.7")}}, records)
	want := journal.RouteRecord{Upstreams: []journal.RouteUpstream{{Container: "sk-api-r2-1", Port: 8080, Weight: 1}}, Written: [][]string{{"172.18.0.7:8080"}}}
	if !slices.Equal(adoption.Adopted, []string{"api-prod"}) || !reflect.DeepEqual(records.record(route.ID), want) {
		t.Fatalf("adoption = %+v, record = %+v", adoption, records.record(route.ID))
	}
}

func TestAdoptionRecordsNothingWithoutDocker(t *testing.T) {
	route := legacyRoute([]string{"172.18.0.5:8080"})
	records := &fakeRecords{}
	containers := downInventory{inventory{fakeContainers{"sk-api-1": appContainer("api-prod", "172.18.0.5")}}}
	if _, err := AdoptRoutes(context.Background(), routeList{route}, containers, &RouteBook{Store: records}, time.Now()); err == nil {
		t.Fatal("adoption went on without Docker")
	}
	if len(records.routes) != 0 {
		t.Fatalf("records = %+v", records.routes)
	}
}
