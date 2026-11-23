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
	RemoveRoute(ctx context.Context, id string) error
	SetPlainHosts(ctx context.Context, add, remove []string) error
}

// Containers resolves container upstreams (ADR 0017); the Docker engine implements it.
type Containers interface {
	Container(ctx context.Context, ref string) (docker.Container, error)
}

// RouteRecords keeps the containers each route proxies to (the journal), so that reconciliation
// follows a container that comes back at another address.
type RouteRecords interface {
	SetRouteUpstreams(ctx context.Context, route string, upstreams []journal.RouteUpstream, now time.Time) error
	ClearRouteUpstreams(ctx context.Context, route string) error
}

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
func RouteHandlers(router Router, containers Containers, records RouteRecords, sleep func(context.Context, time.Duration) error, reserved ...string) map[string]Handler {
	if sleep == nil {
		sleep = wait
	}
	return map[string]Handler{
		"upsert_route": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return upsertRoute(router, containers, records, sleep, req.GetUpsertRoute().GetRoute(), reserved)
		}, Result: resourceResult},
		"remove_route": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return removeRoute(router, records, sleep, req.GetRemoveRoute())
		}, Result: resourceResult},
	}
}

// upsertRoute switches traffic atomically, then waits for in-flight requests to drain from the
// replaced upstreams before reporting success (switch-then-drain, ADR 0005).
func upsertRoute(router Router, containers Containers, records RouteRecords, sleep func(context.Context, time.Duration) error, route *agentv1.Route, reserved []string) (journal.Plan, error) {
	template, local, plain, drain, err := caddyRoute(route)
	if err != nil {
		return journal.Plan{}, err
	}
	for _, host := range hostsOf(template) {
		if slices.ContainsFunc(reserved, func(name string) bool { return covers(host, name) }) {
			return journal.Plan{}, errInput
		}
	}
	// Unknown after a restart: draining again is harmless, skipping it is not.
	replaced := true
	return journal.Plan{Version: "upsert-route-v1", Steps: []journal.Step{
		{
			Name:      "apply",
			RetrySafe: true,
			Apply: func(ctx context.Context) (journal.Outcome, error) {
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
				// One unit, ordered so that a failed write leaves every host reachable (ApplyRoute).
				if err := router.ApplyRoute(ctx, desired, add, remove); err != nil {
					return journal.Outcome{}, fmt.Errorf("apply route: %w", err)
				}
				// What each container resolved to, for reconciliation; none for the maintenance
				// page or address upstreams, which clears an older record.
				if records != nil {
					if err := records.SetRouteUpstreams(ctx, desired.ID, recorded(desired, local), time.Now()); err != nil {
						return journal.Outcome{}, fmt.Errorf("record route upstreams: %w", err)
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

func removeRoute(router Router, records RouteRecords, sleep func(context.Context, time.Duration) error, action *agentv1.RemoveRoute) (journal.Plan, error) {
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
				previous, existed, err := router.Route(ctx, id)
				if err != nil {
					return journal.Outcome{}, fmt.Errorf("read route: %w", err)
				}
				if records != nil {
					if err := records.ClearRouteUpstreams(ctx, id); err != nil {
						return journal.Outcome{}, fmt.Errorf("forget route upstreams: %w", err)
					}
				}
				if !existed {
					return journal.Outcome{ResourceID: id}, nil
				}
				if err := router.RemoveRoute(ctx, id); err != nil {
					return journal.Outcome{}, fmt.Errorf("remove route: %w", err)
				}
				if err := router.SetPlainHosts(ctx, nil, hostsOf(previous)); err != nil {
					return journal.Outcome{}, fmt.Errorf("set plain hosts: %w", err)
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
	handler := caddy.Handler{Handler: "reverse_proxy", Upstreams: upstreams}
	if weighted {
		handler.LoadBalancing = &caddy.LoadBalancing{SelectionPolicy: map[string]any{"policy": "weighted_round_robin", "weights": weights}}
	}
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
	if err != nil {
		return "", fmt.Errorf("inspect upstream container: %w", err)
	}
	if container.Config.Labels[docker.ManagedLabel] != "true" || !container.State.Running {
		return "", errInput
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
			return netip.AddrPortFrom(address, port).String(), nil
		}
	}
	return "", errInput
}

// recorded lists the container upstreams of an applied route with the address each resolved to.
func recorded(route caddy.Route, local []localUpstream) []journal.RouteUpstream {
	upstreams := make([]journal.RouteUpstream, 0, len(local))
	for _, upstream := range local {
		upstreams = append(upstreams, journal.RouteUpstream{
			Index:     upstream.index,
			Container: upstream.name,
			Port:      upstream.port,
			Dial:      route.Handle[0].Upstreams[upstream.index].Dial,
		})
	}
	return upstreams
}

// RouteUpdater rewrites one route under the Caddy client's lock (caddy.Client.UpdateRoute).
type RouteUpdater interface {
	UpdateRoute(ctx context.Context, id string, change func(caddy.Route) (caddy.Route, bool)) error
}

// RouteStore reads and writes the recorded container upstreams of routes (the journal).
type RouteStore interface {
	RouteRecords
	RouteUpstreams(ctx context.Context) (map[string][]journal.RouteUpstream, error)
}

// RouteRefresher follows containers that came back at another address (ADR 0017, PLAN M1.6). Docker
// gives a restarted container whatever address is free: another container may have taken its old
// one, and the route would then send its traffic there. Each pass resolves every recorded
// container again and moves the route to its new address, as long as the route still holds the
// address the agent set: a route an action wrote meanwhile is left to that action. A container that
// is not running is left until it runs again.
type RouteRefresher struct {
	Router     RouteUpdater
	Containers Containers
	Records    RouteStore
	Now        func() time.Time
}

// Refresh runs one pass over every recorded route.
func (r RouteRefresher) Refresh(ctx context.Context) error {
	routes, err := r.Records.RouteUpstreams(ctx)
	if err != nil {
		return err
	}
	var failures []error
	for id, upstreams := range routes {
		current := slices.Clone(upstreams)
		changed := false
		err := r.Router.UpdateRoute(ctx, id, func(route caddy.Route) (caddy.Route, bool) {
			if len(route.Handle) != 1 || route.Handle[0].Handler != "reverse_proxy" {
				return route, false
			}
			handler := route.Handle[0]
			handler.Upstreams = slices.Clone(handler.Upstreams)
			for i, upstream := range upstreams {
				if upstream.Index >= len(handler.Upstreams) || handler.Upstreams[upstream.Index].Dial != upstream.Dial {
					continue
				}
				dial, err := containerDial(ctx, r.Containers, upstream.Container, upstream.Port)
				if err != nil || dial == upstream.Dial || slices.ContainsFunc(handler.Upstreams, func(u caddy.Upstream) bool { return u.Dial == dial }) {
					continue
				}
				handler.Upstreams[upstream.Index] = caddy.Upstream{Dial: dial}
				current[i].Dial = dial
				changed = true
			}
			route.Handle = []caddy.Handler{handler}
			return route, changed
		})
		if err != nil {
			failures = append(failures, fmt.Errorf("refresh route: %w", err))
			continue
		}
		if changed {
			if err := r.Records.SetRouteUpstreams(ctx, id, current, r.now()); err != nil {
				failures = append(failures, err)
			}
		}
	}
	return errors.Join(failures...)
}

func (r RouteRefresher) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}
