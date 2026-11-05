package actions

import (
	"context"
	"fmt"
	"math"
	"net/netip"
	"regexp"
	"slices"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/samuelmbabhazi/shipkeep/agent/internal/caddy"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/docker"
	"github.com/samuelmbabhazi/shipkeep/agent/internal/journal"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Router is the part of the Caddy client the route handlers use; tests substitute a fake.
type Router interface {
	EnsureServer(ctx context.Context) error
	Route(ctx context.Context, id string) (caddy.Route, bool, error)
	UpsertRoute(ctx context.Context, route caddy.Route) error
	RemoveRoute(ctx context.Context, id string) error
	SetPlainHosts(ctx context.Context, add, remove []string) error
}

// Containers resolves container upstreams (ADR 0017); the Docker engine implements it.
type Containers interface {
	Container(ctx context.Context, ref string) (docker.Container, error)
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
func RouteHandlers(router Router, containers Containers, sleep func(context.Context, time.Duration) error) map[string]Handler {
	if sleep == nil {
		sleep = wait
	}
	return map[string]Handler{
		"upsert_route": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return upsertRoute(router, containers, sleep, req.GetUpsertRoute().GetRoute())
		}, Result: resourceResult},
		"remove_route": {Plan: func(req *agentv1.ActionRequest) (journal.Plan, error) {
			return removeRoute(router, sleep, req.GetRemoveRoute())
		}, Result: resourceResult},
	}
}

// upsertRoute switches traffic atomically, then waits for in-flight requests to drain from the
// replaced upstreams before reporting success (switch-then-drain, ADR 0005).
func upsertRoute(router Router, containers Containers, sleep func(context.Context, time.Duration) error, route *agentv1.Route) (journal.Plan, error) {
	template, local, plain, drain, err := caddyRoute(route)
	if err != nil {
		return journal.Plan{}, err
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
				if err := router.SetPlainHosts(ctx, add, remove); err != nil {
					return journal.Outcome{}, fmt.Errorf("set plain hosts: %w", err)
				}
				if err := router.UpsertRoute(ctx, desired); err != nil {
					return journal.Outcome{}, fmt.Errorf("upsert route: %w", err)
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

func removeRoute(router Router, sleep func(context.Context, time.Duration) error, action *agentv1.RemoveRoute) (journal.Plan, error) {
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
// separately with an empty dial address, filled by resolveUpstreams when the route is applied.
func caddyRoute(route *agentv1.Route) (caddy.Route, []localUpstream, bool, time.Duration, error) {
	fail := func() (caddy.Route, []localUpstream, bool, time.Duration, error) {
		return caddy.Route{}, nil, false, 0, errInput
	}
	if route == nil || !routeID.MatchString(route.GetRouteId()) || len(route.GetHosts()) == 0 || len(route.GetHosts()) > maxHosts ||
		len(route.GetUpstreams()) == 0 || len(route.GetUpstreams()) > maxUpstreams {
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
	return caddy.Route{ID: caddy.RouteID(route.GetRouteId()), Match: []caddy.Match{{Host: hosts}}, Handle: []caddy.Handler{handler}, Terminal: true}, local, plain, drain, nil
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
		container, err := containers.Container(ctx, upstream.name)
		if err != nil {
			return caddy.Route{}, fmt.Errorf("inspect upstream container: %w", err)
		}
		if container.Config.Labels[docker.ManagedLabel] != "true" || !container.State.Running {
			return caddy.Route{}, errInput
		}
		networks := []string{}
		for network := range container.NetworkSettings.Networks {
			if resourceName.MatchString(network) {
				networks = append(networks, network)
			}
		}
		slices.Sort(networks)
		dial := ""
		for _, network := range networks {
			address, err := netip.ParseAddr(container.NetworkSettings.Networks[network].IPAddress)
			if err == nil && address.IsPrivate() {
				dial = netip.AddrPortFrom(address, upstream.port).String()
				break
			}
		}
		if dial == "" || slices.ContainsFunc(handler.Upstreams, func(u caddy.Upstream) bool { return u.Dial == dial }) {
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
