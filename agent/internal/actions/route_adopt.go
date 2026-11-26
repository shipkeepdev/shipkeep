package actions

import (
	"context"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
)

// ApplicationLabel is the label the control plane gives every container of an application: the
// application's id, which is also the id of the application's route.
const ApplicationLabel = "shipkeep.application"

// Why a route was not adopted. Codes only: never an address, a name or an error text.
const (
	// AdoptNoContainer: no running managed container has an address the route proxies to.
	AdoptNoContainer = "no_running_container"
	// AdoptOtherApplication: the container at an address the route proxies to belongs to another
	// application, or to none. The route already sends its traffic elsewhere.
	AdoptOtherApplication = "other_application"
	// AdoptUnexpected: the route is not one an agent writes (an upstream that is not a private
	// address and port, the same address twice, or weights out of range).
	AdoptUnexpected = "unexpected_route"
)

// RouteLister lists the routes of the Shipkeep server; the Caddy client implements it.
type RouteLister interface {
	Routes(ctx context.Context) ([]caddy.Route, error)
}

// Inventory lists and inspects the managed containers; the Docker engine implements it.
type Inventory interface {
	Containers
	ManagedContainers(ctx context.Context) ([]docker.ContainerSummary, error)
}

// Adoption is what AdoptRoutes found: the routes already followed, the routes it recorded, and the
// routes it could not tie to their containers, by Shipkeep route id, with why.
type Adoption struct {
	Followed, Adopted []string
	Refused           map[string]string
}

// AdoptRoutes records the routes that agents up to 0.1.0-alpha.3 wrote without a record (ADR
// 0017), so that from now on they follow their containers when Docker gives them other addresses.
// It runs once, from the installer's migration, while the agent is stopped and before Docker
// restarts: until then each container still has the address the route was given.
//
// A route is adopted only when every address it proxies to is the address of a running managed
// container of the route's own application, by its label, so that a route whose traffic already
// goes elsewhere is never recorded as right. Such a route, and any other it cannot read, is left
// as it is and named in Refused: its application is deployed again to give it a record. A route
// whose record matches what Caddy holds is already followed. Nothing is written to Caddy.
func AdoptRoutes(ctx context.Context, routes RouteLister, containers Inventory, book *RouteBook, now time.Time) (Adoption, error) {
	listed, err := routes.Routes(ctx)
	if err != nil {
		return Adoption{}, fmt.Errorf("list routes: %w", err)
	}
	owners, err := addressOwners(ctx, containers)
	if err != nil {
		return Adoption{}, err
	}
	defer book.lock()()
	adoption := Adoption{Refused: map[string]string{}}
	for _, route := range listed {
		application, ok := caddy.RouteName(route.ID)
		if !ok || !routeID.MatchString(application) || len(route.Handle) != 1 || route.Handle[0].Handler != "reverse_proxy" {
			// Not a Shipkeep route, or one with nothing to follow: the agent's 503 answer, the
			// maintenance page.
			continue
		}
		record, found, err := book.Store.RouteRecord(ctx, route.ID)
		if err != nil {
			return adoption, fmt.Errorf("read route record: %w", err)
		}
		if _, ours := written(route, record); found && ours {
			adoption.Followed = append(adoption.Followed, application)
			continue
		}
		upstreams, reason := adopted(route.Handle[0], application, owners)
		if reason != "" {
			adoption.Refused[application] = reason
			continue
		}
		next := journal.RouteRecord{Upstreams: upstreams, Written: [][]string{dials(route)}}
		if err := book.Store.SetRouteRecord(ctx, route.ID, next, now); err != nil {
			return adoption, fmt.Errorf("record route: %w", err)
		}
		adoption.Adopted = append(adoption.Adopted, application)
	}
	return adoption, nil
}

// addressOwner is the running managed container at an address.
type addressOwner struct {
	name, application string
	// shared marks an address two containers report: neither is taken for it.
	shared bool
}

// addressOwners maps each running managed container's service address to the container.
func addressOwners(ctx context.Context, containers Inventory) (map[netip.Addr]addressOwner, error) {
	summaries, err := containers.ManagedContainers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	owners := map[netip.Addr]addressOwner{}
	for _, summary := range summaries {
		if len(summary.Names) == 0 {
			continue
		}
		name := strings.TrimPrefix(summary.Names[0], "/")
		if !resourceName.MatchString(name) {
			continue
		}
		container, err := containers.Container(ctx, summary.ID)
		if err != nil {
			// Docker did not answer, or the container went away: nothing is recorded on a guess.
			return nil, fmt.Errorf("inspect container: %w", err)
		}
		address, ok := serviceAddress(container)
		if !ok {
			continue
		}
		if _, taken := owners[address]; taken {
			owners[address] = addressOwner{shared: true}
			continue
		}
		owners[address] = addressOwner{name: name, application: container.Config.Labels[ApplicationLabel]}
	}
	return owners, nil
}

// adopted lists the upstreams of a route's handler as a record keeps them, or says why it cannot.
func adopted(handler caddy.Handler, application string, owners map[netip.Addr]addressOwner) ([]journal.RouteUpstream, string) {
	if len(handler.Upstreams) == 0 || len(handler.Upstreams) > maxUpstreams {
		return nil, AdoptUnexpected
	}
	weights := installedWeights(handler)
	if handler.LoadBalancing != nil && len(weights) != len(handler.Upstreams) {
		return nil, AdoptUnexpected
	}
	upstreams := make([]journal.RouteUpstream, 0, len(handler.Upstreams))
	for index, upstream := range handler.Upstreams {
		dial, err := netip.ParseAddrPort(upstream.Dial)
		if err != nil || dial.Port() == 0 || !dial.Addr().IsPrivate() || dial.String() != upstream.Dial {
			return nil, AdoptUnexpected
		}
		weight := 1
		if weights != nil {
			weight = weights[index]
		}
		if weight < 1 || weight > maxWeight {
			return nil, AdoptUnexpected
		}
		owner, ok := owners[dial.Addr()]
		switch {
		case !ok:
			return nil, AdoptNoContainer
		case owner.shared || owner.application != application:
			return nil, AdoptOtherApplication
		}
		if slices.ContainsFunc(upstreams, func(u journal.RouteUpstream) bool { return u.Container == owner.name && u.Port == dial.Port() }) {
			return nil, AdoptUnexpected
		}
		upstreams = append(upstreams, journal.RouteUpstream{Container: owner.name, Port: dial.Port(), Weight: weight})
	}
	return upstreams, ""
}
