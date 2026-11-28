package actions

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/netip"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/shipkeepdev/shipkeep/agent/internal/caddy"
	"github.com/shipkeepdev/shipkeep/agent/internal/docker"
	"github.com/shipkeepdev/shipkeep/agent/internal/journal"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Router is the part of the Caddy client the route handlers use; tests substitute a fake.
type Router interface {
	EnsureServer(ctx context.Context) error
	Route(ctx context.Context, id string) (caddy.Route, bool, error)
	ApplyRoute(ctx context.Context, route caddy.Route, plainAdd, plainRemove []string) error
	RemoveRoute(ctx context.Context, id string, plainRemove []string) error
}

// Containers resolves container upstreams (ADR 0017); the Docker engine implements it.
type Containers interface {
	Container(ctx context.Context, ref string) (docker.Container, error)
}

// RouteStore keeps a record of each route that proxies to local containers (the journal), so that
// reconciliation follows a container that comes back at another address.
type RouteStore interface {
	RouteRecord(ctx context.Context, route string) (journal.RouteRecord, bool, error)
	SetRouteRecord(ctx context.Context, route string, record journal.RouteRecord, now time.Time) error
	ClearRouteRecord(ctx context.Context, route string) error
	RecordedRoutes(ctx context.Context) ([]string, error)
}

// RouteBook is the store of route records with the lock that orders every change to a recorded
// route. The route actions and the refresher share one, and each writes a route to Caddy and its
// record under it: neither replaces a route or a record the other has just written.
type RouteBook struct {
	Store RouteStore
	mu    sync.Mutex
}

// lock takes the book's lock and returns its release; a nil book records nothing and locks nothing.
func (b *RouteBook) lock() func() {
	if b == nil {
		return func() {}
	}
	b.mu.Lock()
	return b.mu.Unlock
}

// errNotServing is a container upstream that cannot take traffic: absent, not managed, not
// running, or without a private address on a Shipkeep network.
var errNotServing = fmt.Errorf("%w: upstream container not serving", errInput)

// localUpstream is a container upstream, resolved to a dial address when the route is applied.
type localUpstream struct {
	index int
	name  string
	port  uint16
}

const (
	maxHosts         = 32
	maxUpstreams     = 64
	maxWeight        = 100
	maxDrain         = 5 * time.Minute
	defaultDrain     = 30 * time.Second
	maxHostnameBytes = 253
)

var (
	routeID  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	hostname = regexp.MustCompile(`^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
)

// RouteHandlers returns the Caddy-backed route handlers; sleep waits for draining (tests shorten it).
// A route for a reserved host, or a wildcard that covers one, is refused (ADR 0021).
func RouteHandlers(router Router, containers Containers, book *RouteBook, sleep func(context.Context, time.Duration) error, reserved ...string) map[string]Handler {
	if sleep == nil {
		sleep = wait
	}
	return map[string]Handler{
		"upsert_route": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return upsertRoute(router, containers, book, sleep, req.GetUpsertRoute().GetRoute(), reserved)
		}, Result: resourceResult},
		"remove_route": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return removeRoute(router, book, sleep, req.GetRemoveRoute())
		}, Result: resourceResult},
	}
}

// upsertRoute switches traffic atomically, then waits for in-flight requests to drain from the
// replaced upstreams before reporting success (switch-then-drain, ADR 0005).
func upsertRoute(router Router, containers Containers, book *RouteBook, sleep func(context.Context, time.Duration) error, route *agentv1.Route, reserved []string) (journal.Plan, error) {
	template, local, plain, drain, err := caddyRoute(route)
	if err != nil {
		return journal.Plan{}, err
	}
	for _, host := range hostsOf(template) {
		if slices.ContainsFunc(reserved, func(name string) bool { return covers(host, name) }) {
			return journal.Plan{}, errInput
		}
	}
	asked := askedUpstreams(route, template, local)
	// Unknown after a restart: draining again is harmless, skipping it is not.
	replaced := true
	return journal.Plan{Version: "upsert-route-v1", Steps: []journal.Step{
		{
			Name:      "apply",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				defer book.lock()()
				desired, err := resolveUpstreams(ctx, containers, template, local)
				if err != nil {
					return journal.Outcome{}, err
				}
				if err := router.EnsureServer(ctx); err != nil {
					return journal.Outcome{}, fmt.Errorf("ensure caddy server: %w", err)
				}
				previous, existed, err := router.Route(ctx, desired.ID)
				if err != nil {
					return journal.Outcome{}, fmt.Errorf("read route: %w", err)
				}
				replaced = existed
				hosts := desired.Match[0].Host
				add, remove := []string{}, hostsOf(previous)
				if plain {
					add = hosts
				} else {
					remove = append(remove, hosts...)
				}
				remove = slices.DeleteFunc(remove, func(host string) bool { return plain && slices.Contains(hosts, host) })
				// A route to local containers is recorded before Caddy gets it, with the dials it is
				// about to hold. If the write fails, the old route holds none of them, and
				// reconciliation leaves it as it is rather than give it the new upstreams.
				var before journal.RouteRecord
				var hadRecord, recorded bool
				if book != nil && len(local) > 0 {
					if before, hadRecord, err = book.Store.RouteRecord(ctx, desired.ID); err != nil {
						return journal.Outcome{}, fmt.Errorf("read route record: %w", err)
					}
					record := journal.RouteRecord{Upstreams: asked, Written: [][]string{dials(desired)}}
					if err := book.Store.SetRouteRecord(ctx, desired.ID, record, time.Now()); err != nil {
						return journal.Outcome{}, fmt.Errorf("record route: %w", err)
					}
					recorded = true
				}
				// One write: the route and its hosts without TLS change together (ApplyRoute).
				if err := router.ApplyRoute(ctx, desired, add, remove); err != nil {
					// Caddy kept the route it had: the record describes that one again, so that it
					// keeps following its containers. A crash before this point resumes the action.
					if recorded {
						if hadRecord {
							err = errors.Join(err, book.Store.SetRouteRecord(ctx, desired.ID, before, time.Now()))
						} else {
							err = errors.Join(err, book.Store.ClearRouteRecord(ctx, desired.ID))
						}
					}
					return journal.Outcome{}, fmt.Errorf("apply route: %w", err)
				}
				// The maintenance page and address upstreams have nothing to follow.
				if book != nil && len(local) == 0 {
					if err := book.Store.ClearRouteRecord(ctx, desired.ID); err != nil {
						return journal.Outcome{}, fmt.Errorf("forget route record: %w", err)
					}
				}
				return journal.Outcome{ResourceID: desired.ID}, nil
			},
			Compensate: func(context.Context) error { return nil },
		},
		{
			Name:      "drain",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				if replaced {
					if err := sleep(ctx, drain); err != nil {
						return journal.Outcome{}, err
					}
				}
				return journal.Outcome{ResourceID: template.ID}, nil
			},
			Compensate: func(context.Context) error { return nil },
		},
	}}, nil
}

func removeRoute(router Router, book *RouteBook, sleep func(context.Context, time.Duration) error, action *agentv1.RemoveRoute) (journal.Plan, error) {
	if !routeID.MatchString(action.GetRouteId()) {
		return journal.Plan{}, errInput
	}
	drain, err := drainTimeout(action.GetDrainTimeout())
	if err != nil {
		return journal.Plan{}, err
	}
	id := caddy.RouteID(action.GetRouteId())
	return journal.Plan{Version: "remove-route-v1", Steps: []journal.Step{
		{
			Name:      "remove",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				defer book.lock()()
				previous, existed, err := router.Route(ctx, id)
				if err != nil {
					return journal.Outcome{}, fmt.Errorf("read route: %w", err)
				}
				// The route and its hosts without TLS go in one write (RemoveRoute).
				if existed {
					if err := router.RemoveRoute(ctx, id, hostsOf(previous)); err != nil {
						return journal.Outcome{}, fmt.Errorf("remove route: %w", err)
					}
				}
				// Only once the route is gone: until then, reconciliation keeps following its
				// containers.
				if book != nil {
					if err := book.Store.ClearRouteRecord(ctx, id); err != nil {
						return journal.Outcome{}, fmt.Errorf("forget route record: %w", err)
					}
				}
				return journal.Outcome{ResourceID: id}, nil
			},
			Compensate: func(context.Context) error { return nil },
		},
		{
			Name:      "drain",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
				if err := sleep(ctx, drain); err != nil {
					return journal.Outcome{}, err
				}
				return journal.Outcome{ResourceID: id}, nil
			},
			Compensate: func(context.Context) error { return nil },
		},
	}}, nil
}

// caddyRoute validates a route and builds its typed Caddy form. Container upstreams are returned
// separately with an empty dial address, filled by resolveUpstreams when the route is applied. A
// maintenance route has no upstream: Caddy answers with the agent's own page (ADR 0025).
func caddyRoute(route *agentv1.Route) (caddy.Route, []localUpstream, bool, time.Duration, error) {
	fail := func() (caddy.Route, []localUpstream, bool, time.Duration, error) {
		return caddy.Route{}, nil, false, 0, errInput
	}
	if route == nil || !routeID.MatchString(route.GetRouteId()) || len(route.GetHosts()) == 0 || len(route.GetHosts()) > maxHosts ||
		len(route.GetUpstreams()) > maxUpstreams {
		return fail()
	}
	// Exactly one of the two: upstreams to proxy to, or the maintenance page.
	if route.GetMaintenance() != (len(route.GetUpstreams()) == 0) {
		return fail()
	}
	hosts := []string{}
	for _, host := range route.GetHosts() {
		if len(host) > maxHostnameBytes || !hostname.MatchString(host) || slices.Contains(hosts, host) {
			return fail()
		}
		hosts = append(hosts, host)
	}
	upstreams, weights, weighted, local := []caddy.Upstream{}, []int{}, false, []localUpstream{}
	for index, upstream := range route.GetUpstreams() {
		if upstream.GetWeight() > maxWeight {
			return fail()
		}
		if upstream.GetContainer() != "" || upstream.GetPort() != 0 {
			name, raw := upstream.GetContainer(), upstream.GetPort()
			// A local container by name (ADR 0017); never together with an address.
			if upstream.GetAddress() != "" || !resourceName.MatchString(name) || raw == 0 || raw > math.MaxUint16 {
				return fail()
			}
			port := uint16(raw)
			if slices.ContainsFunc(local, func(u localUpstream) bool { return u.name == name && u.port == port }) {
				return fail()
			}
			local = append(local, localUpstream{index: index, name: name, port: port})
			upstreams = append(upstreams, caddy.Upstream{})
		} else {
			address, err := netip.ParseAddrPort(upstream.GetAddress())
			// Only Docker and WireGuard network addresses: private IP literals with a port.
			if err != nil || address.String() != upstream.GetAddress() || !address.Addr().IsPrivate() || address.Port() == 0 ||
				slices.ContainsFunc(upstreams, func(u caddy.Upstream) bool { return u.Dial == address.String() }) {
				return fail()
			}
			upstreams = append(upstreams, caddy.Upstream{Dial: address.String()})
		}
		weight := max(int(upstream.GetWeight()), 1)
		weighted = weighted || weight != 1
		weights = append(weights, weight)
	}
	var plain bool
	switch route.GetTlsMode() {
	case agentv1.TlsMode_TLS_MODE_UNSPECIFIED, agentv1.TlsMode_TLS_MODE_AUTO_HTTP:
	case agentv1.TlsMode_TLS_MODE_OFF:
		plain = true
	case agentv1.TlsMode_TLS_MODE_AUTO_DNS:
		// DNS-01 needs a provider configuration the agent does not have yet.
		return fail()
	default:
		return fail()
	}
	drain, err := drainTimeout(route.GetDrainTimeout())
	if err != nil {
		return caddy.Route{}, nil, false, 0, err
	}
	handler := proxyHandler(upstreams, weights, weighted)
	if route.GetMaintenance() {
		handler = caddy.MaintenanceHandler()
	}
	// Under automatic HTTPS the route answers HTTPS only, so that plain HTTP gets Caddy's redirect.
	protocol := caddy.HTTPS
	if plain {
		protocol = ""
	}
	match := caddy.HostMatch(hosts, protocol)
	return caddy.Route{ID: caddy.RouteID(route.GetRouteId()), Match: []caddy.Match{match}, Handle: []caddy.Handler{handler}, Terminal: true}, local, plain, drain, nil
}

// proxyHandler proxies to upstreams, by weighted round robin when the route gave weights.
func proxyHandler(upstreams []caddy.Upstream, weights []int, weighted bool) caddy.Handler {
	handler := caddy.Handler{Handler: "reverse_proxy", Upstreams: upstreams}
	if weighted {
		handler.LoadBalancing = &caddy.LoadBalancing{SelectionPolicy: map[string]any{"policy": "weighted_round_robin", "weights": weights}}
	}
	return handler
}

// installedWeights reads the weights of a weighted round robin handler, as the agent wrote them or
// as Caddy gives them back (JSON numbers); none for an unweighted one.
func installedWeights(handler caddy.Handler) []int {
	if handler.LoadBalancing == nil {
		return nil
	}
	weights := []int{}
	switch values := handler.LoadBalancing.SelectionPolicy["weights"].(type) {
	case []int:
		weights = append(weights, values...)
	case []any:
		for _, value := range values {
			number, ok := value.(float64)
			if !ok {
				return nil
			}
			weights = append(weights, int(number))
		}
	default:
		return nil
	}
	return weights
}

// resolveUpstreams returns a copy of template with every container upstream resolved to the
// container's private address on its first Shipkeep network, by name order (ADR 0017).
func resolveUpstreams(ctx context.Context, containers Containers, template caddy.Route, local []localUpstream) (caddy.Route, error) {
	if len(local) == 0 {
		return template, nil
	}
	handler := template.Handle[0]
	handler.Upstreams = slices.Clone(handler.Upstreams)
	for _, upstream := range local {
		dial, err := containerDial(ctx, containers, upstream.name, upstream.port)
		if err != nil {
			return caddy.Route{}, err
		}
		if slices.ContainsFunc(handler.Upstreams, func(u caddy.Upstream) bool { return u.Dial == dial }) {
			return caddy.Route{}, errInput
		}
		handler.Upstreams[upstream.index] = caddy.Upstream{Dial: dial}
	}
	route := template
	route.Handle = []caddy.Handler{handler}
	return route, nil
}

func drainTimeout(value *durationpb.Duration) (time.Duration, error) {
	if value == nil {
		return defaultDrain, nil
	}
	drain := value.AsDuration()
	if value.CheckValid() != nil || drain < 0 || drain > maxDrain {
		return 0, errInput
	}
	return drain, nil
}

// covers reports whether a route host matches name: the same name, or a wildcard for exactly one
// more label, as Caddy matches it.
func covers(host, name string) bool {
	if host == name {
		return true
	}
	suffix, wildcard := strings.CutPrefix(host, "*")
	if !wildcard {
		return false
	}
	label, found := strings.CutSuffix(name, suffix)
	return found && label != "" && !strings.Contains(label, ".")
}

func hostsOf(route caddy.Route) []string {
	hosts := []string{}
	for _, match := range route.Match {
		hosts = append(hosts, match.Host...)
	}
	return hosts
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err() //nolint:wrapcheck // cancellation passes through
	case <-timer.C:
		return nil
	}
}

// containerDial is a running managed container's private address on its first Shipkeep network,
// by name order, with port (ADR 0017).
func containerDial(ctx context.Context, containers Containers, name string, port uint16) (string, error) {
	container, err := containers.Container(ctx, name)
	if errors.Is(err, docker.ErrNotFound) {
		return "", errNotServing
	}
	if err != nil {
		return "", fmt.Errorf("inspect upstream container: %w", err)
	}
	address, ok := serviceAddress(container)
	if !ok {
		return "", errNotServing
	}
	return netip.AddrPortFrom(address, port).String(), nil
}

// serviceAddress is the address routes reach a container at: for a running managed container, its
// private address on its first Shipkeep network, by name order (ADR 0017).
func serviceAddress(container docker.Container) (netip.Addr, bool) {
	if container.Config.Labels[docker.ManagedLabel] != "true" || !container.State.Running {
		return netip.Addr{}, false
	}
	networks := []string{}
	for network := range container.NetworkSettings.Networks {
		if resourceName.MatchString(network) {
			networks = append(networks, network)
		}
	}
	slices.Sort(networks)
	for _, network := range networks {
		address, err := netip.ParseAddr(container.NetworkSettings.Networks[network].IPAddress)
		if err == nil && address.IsPrivate() {
			return address, true
		}
	}
	return netip.Addr{}, false
}

// askedUpstreams lists a validated route's upstreams as the journal records them: containers by
// name and port, addresses as given, each with its weight.
func askedUpstreams(route *agentv1.Route, template caddy.Route, local []localUpstream) []journal.RouteUpstream {
	asked := make([]journal.RouteUpstream, 0, len(route.GetUpstreams()))
	for index, upstream := range route.GetUpstreams() {
		asked = append(asked, journal.RouteUpstream{Address: template.Handle[0].Upstreams[index].Dial, Weight: max(int(upstream.GetWeight()), 1)})
	}
	for _, upstream := range local {
		asked[upstream.index] = journal.RouteUpstream{Container: upstream.name, Port: upstream.port, Weight: asked[upstream.index].Weight}
	}
	return asked
}

// dials lists the addresses a route proxies to, in order: none for the agent's 503 answer.
func dials(route caddy.Route) []string {
	addresses := []string{}
	if len(route.Handle) == 1 {
		for _, upstream := range route.Handle[0].Upstreams {
			addresses = append(addresses, upstream.Dial)
		}
	}
	return addresses
}

// RouteUpdater rewrites one route under the Caddy client's lock (caddy.Client.UpdateRoute).
type RouteUpdater interface {
	UpdateRoute(ctx context.Context, id string, change func(caddy.Route) (caddy.Route, bool)) error
}

// RouteRefresher follows the containers of recorded routes (ADR 0017, PLAN M1.6). Docker gives a
// restarted container whatever address is free: another container may have taken its old one, and
// the route would then send its traffic there. Each pass resolves every recorded container again
// and gives the route the address of each one that runs. A container that does not run gets no
// traffic, and a route none of whose containers runs answers 503, rather than keep an address
// another container may now hold. Only a route that holds dials the agent wrote is changed: one
// written by anything else is left as it is.
type RouteRefresher struct {
	Router     RouteUpdater
	Containers Containers
	Book       *RouteBook
	Now        func() time.Time
}

// Refresh runs one pass over every recorded route.
func (r RouteRefresher) Refresh(ctx context.Context) error {
	routes, err := r.Book.Store.RecordedRoutes(ctx)
	if err != nil {
		return fmt.Errorf("list route records: %w", err)
	}
	var failures []error
	for _, id := range routes {
		if err := r.refresh(ctx, id); err != nil {
			failures = append(failures, fmt.Errorf("refresh route %s: %w", id, err))
		}
	}
	return errors.Join(failures...)
}

// refresh brings one route to its containers' current addresses, under the book's lock, so that
// no route action writes the route or its record in between.
func (r RouteRefresher) refresh(ctx context.Context, id string) error {
	defer r.Book.lock()()
	record, found, err := r.Book.Store.RouteRecord(ctx, id)
	if err != nil || !found {
		return err
	}
	wanted, weights, err := r.resolve(ctx, record.Upstreams)
	if err != nil {
		return err
	}
	var held []string
	var ahead error
	err = r.Router.UpdateRoute(ctx, id, func(route caddy.Route) (caddy.Route, bool) {
		current, ours := written(route, record)
		if !ours {
			return route, false
		}
		held = current
		// Positional weights: the same addresses may now belong to other upstreams.
		wantedWeights := []int(nil)
		weighted := slices.ContainsFunc(record.Upstreams, func(u journal.RouteUpstream) bool { return u.Weight != 1 })
		if weighted && len(wanted) > 0 {
			wantedWeights = weights
		}
		if slices.Equal(current, wanted) && slices.Equal(installedWeights(route.Handle[0]), wantedWeights) {
			return route, false
		}
		// Recorded first: if the write to Caddy fails, or the record after it, the next pass finds
		// the route holding one of the two lists and takes it from there.
		next := record
		next.Written = [][]string{current, wanted}
		if ahead = r.Book.Store.SetRouteRecord(ctx, id, next, r.now()); ahead != nil {
			return route, false
		}
		route.Handle = []caddy.Handler{caddy.UnavailableHandler()}
		if len(wanted) > 0 {
			upstreams := make([]caddy.Upstream, 0, len(wanted))
			for _, dial := range wanted {
				upstreams = append(upstreams, caddy.Upstream{Dial: dial})
			}
			route.Handle = []caddy.Handler{proxyHandler(upstreams, weights, weighted)}
		}
		held = wanted
		return route, true
	})
	if err != nil || ahead != nil {
		return errors.Join(err, ahead)
	}
	if held == nil || len(record.Written) == 1 && slices.Equal(record.Written[0], held) {
		return nil
	}
	record.Written = [][]string{held}
	return r.Book.Store.SetRouteRecord(ctx, id, record, r.now())
}

// resolve lists the dials the route should hold now, with their weights, in the route's order:
// each address, and the current address of each container that runs.
func (r RouteRefresher) resolve(ctx context.Context, upstreams []journal.RouteUpstream) ([]string, []int, error) {
	wanted, weights := []string{}, []int{}
	for _, upstream := range upstreams {
		dial := upstream.Address
		if upstream.Container != "" {
			resolved, err := containerDial(ctx, r.Containers, upstream.Container, upstream.Port)
			if errors.Is(err, errNotServing) {
				continue
			}
			if err != nil {
				// Docker did not answer: nothing is changed on a guess.
				return nil, nil, err
			}
			dial = resolved
		}
		if slices.Contains(wanted, dial) {
			return nil, nil, errors.New("two upstreams of the route resolve to one address")
		}
		wanted = append(wanted, dial)
		weights = append(weights, upstream.Weight)
	}
	return wanted, weights, nil
}

// written returns the dials route holds, and whether the agent wrote them: a reverse proxy, or the
// 503 answer, holding one of the record's lists.
func written(route caddy.Route, record journal.RouteRecord) ([]string, bool) {
	if len(route.Handle) != 1 || route.Handle[0].Handler != "reverse_proxy" && !caddy.IsUnavailable(route.Handle[0]) {
		return nil, false
	}
	current := dials(route)
	return current, slices.ContainsFunc(record.Written, func(list []string) bool { return slices.Equal(list, current) })
}

func (r RouteRefresher) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}
