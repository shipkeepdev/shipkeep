// Package caddy configures the node's edge proxy through Caddy's admin API on a Unix socket
// (ADR 0005). Configuration is typed JSON built from Go structs: no Caddyfile, no templates.
package caddy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	// Server is the one HTTP server the agent owns in Caddy's configuration.
	Server   = "shipkeep"
	maxBody  = 4 << 20
	idPrefix = "sk-route-"
)

// ErrNotFound reports an unknown route id.
var ErrNotFound = errors.New("caddy object not found")

// Client talks to the local Caddy admin socket.
type Client struct {
	http *http.Client
	// routes serializes the read-then-write sequences on routes and on the hosts without TLS: an
	// upsert, a removal, a change of those hosts and the securing of old routes each read a value
	// and write it back, and actions run concurrently.
	routes sync.Mutex
}

// New returns a client for the admin socket at path.
func New(path string) (*Client, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, errors.New("caddy admin socket must be an absolute path")
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "unix", path)
		},
		ResponseHeaderTimeout: 30 * time.Second,
	}
	return &Client{http: &http.Client{Transport: transport}}, nil
}

// Route is one reverse-proxy route as Caddy stores it.
type Route struct {
	ID       string    `json:"@id"`
	Match    []Match   `json:"match"`
	Handle   []Handler `json:"handle"`
	Terminal bool      `json:"terminal"`
}

// Match selects requests by host and, for a route under automatic HTTPS, by protocol.
type Match struct {
	Host []string `json:"host"`
	// Path, set on the control plane's registry route only, selects the registry's API.
	Path []string `json:"path,omitempty"`
	// HeaderRegexp bounds the Host header (see BoundHost): every Shipkeep route carries it.
	HeaderRegexp map[string]HeaderPattern `json:"header_regexp,omitempty"`
	// Protocol is "https" for a route under automatic HTTPS: the server listens on both ports, and
	// Caddy inserts its HTTP-to-HTTPS redirects after the last route that matches a host, so a
	// route that matched plain HTTP too would answer there instead of the redirect. Empty for a
	// route with TLS off, which is served on port 80.
	Protocol string `json:"protocol,omitempty"`
}

// HTTPS is the protocol matcher of a route under automatic HTTPS.
const HTTPS = "https"

// HeaderPattern is one regular expression of Caddy's header_regexp matcher.
type HeaderPattern struct {
	Pattern string `json:"pattern"`
}

// hostBound is the Host header a Shipkeep route accepts: its name, alone or with the port of its
// listener. Caddy's host matcher ignores the port, and any text passes for one, while its request
// metrics label each request with the Host header as sent (ADR 0024): without this bound, a client
// could make one series per invented port and grow Caddy's memory without limit.
const hostBound = `^[^:]+(:443|:80)?$`

// HostMatch matches hosts, with the Host header bounded as every Shipkeep route requires.
func HostMatch(hosts []string, protocol string) Match {
	return Match{Host: hosts, Protocol: protocol, HeaderRegexp: map[string]HeaderPattern{"Host": {Pattern: hostBound}}}
}

// bounded tells whether a match carries the Host bound.
func (m Match) bounded() bool {
	return m.HeaderRegexp["Host"].Pattern == hostBound
}

// Handler is a reverse_proxy handler, or a static_response: the control plane's redirect, or the
// maintenance page.
type Handler struct {
	Handler       string         `json:"handler"`
	Upstreams     []Upstream     `json:"upstreams,omitempty"`
	LoadBalancing *LoadBalancing `json:"load_balancing,omitempty"`
	// StatusCode, Headers and Body belong to a static_response.
	StatusCode int                 `json:"status_code,omitempty"`
	Headers    map[string][]string `json:"headers,omitempty"`
	Body       string              `json:"body,omitempty"`
}

// Upstream is one backend address.
type Upstream struct {
	Dial string `json:"dial"`
}

// LoadBalancing carries weights for weighted round robin.
type LoadBalancing struct {
	SelectionPolicy map[string]any `json:"selection_policy"`
}

type server struct {
	Listen         []string        `json:"listen"`
	Routes         []Route         `json:"routes"`
	AutomaticHTTPS *automaticHTTPS `json:"automatic_https,omitempty"`
}

type automaticHTTPS struct {
	Skip []string `json:"skip,omitempty"`
}

// The ids of the control plane's routes on the machine that hosts it (ADR 0021). They are outside
// the Shipkeep route prefix, so no action can reach them.
const (
	ControlPlaneRegistryRouteID = "shipkeep-control-plane-registry"
	ControlPlaneRouteID         = "shipkeep-control-plane"
	ControlPlaneRedirectRouteID = "shipkeep-control-plane-http"
)

// ControlPlaneRoutes are the routes of the control plane's name: its registry's API (/v2/) over
// HTTPS to the registry's loopback port (ADR 0030), the rest over HTTPS to the control plane's,
// and plain HTTP redirected to HTTPS. The redirect is a route of its own, so that no application
// route placed after it answers that name on HTTP, not even a wildcard with TLS off.
func ControlPlaneRoutes(host, upstream, registry string) []Route {
	registryMatch := HostMatch([]string{host}, HTTPS)
	registryMatch.Path = []string{"/v2", "/v2/*"}
	return []Route{
		{
			ID:       ControlPlaneRegistryRouteID,
			Match:    []Match{registryMatch},
			Handle:   []Handler{{Handler: "reverse_proxy", Upstreams: []Upstream{{Dial: registry}}}},
			Terminal: true,
		},
		{
			ID:       ControlPlaneRouteID,
			Match:    []Match{HostMatch([]string{host}, HTTPS)},
			Handle:   []Handler{{Handler: "reverse_proxy", Upstreams: []Upstream{{Dial: upstream}}}},
			Terminal: true,
		},
		{
			ID:    ControlPlaneRedirectRouteID,
			Match: []Match{HostMatch([]string{host}, "http")},
			Handle: []Handler{{
				Handler:    "static_response",
				StatusCode: http.StatusPermanentRedirect,
				Headers:    map[string][]string{"Location": {"https://{http.request.host}{http.request.uri}"}},
			}},
			Terminal: true,
		},
	}
}

// EnsureControlPlaneRoutes keeps routes, in their order, as the first routes of the Shipkeep
// server, so that they win over any other, and their hosts out of the hosts without TLS. It changes
// nothing when Caddy already holds exactly that, and reports whether it wrote. It creates the
// server when Caddy lost it.
func (c *Client) EnsureControlPlaneRoutes(ctx context.Context, wanted []Route) (bool, error) {
	if err := c.EnsureServer(ctx); err != nil {
		return false, err
	}
	c.routes.Lock()
	defer c.routes.Unlock()
	// One write of the server, as for a route switch: Caddy loads the fixed routes first in the list
	// and the control plane's name under automatic HTTPS together, so no configuration lacks them
	// and lets an application route answer for the host. The other routes are kept as Caddy
	// returned them, so that fields this client does not model survive the rewrite.
	changed := false
	hosts := wanted[0].Match[0].Host
	err := c.writeServer(ctx, func(raw []json.RawMessage, skip []string) ([]json.RawMessage, []string, bool, error) {
		routes := make([]Route, len(raw))
		for i := range raw {
			if err := json.Unmarshal(raw[i], &routes[i]); err != nil {
				return nil, nil, false, fmt.Errorf("decode caddy route: %w", err)
			}
		}
		next := raw
		reorder := len(routes) < len(wanted) || !reflect.DeepEqual(routes[:len(wanted)], wanted)
		if reorder {
			next = make([]json.RawMessage, 0, len(raw)+len(wanted))
			for _, route := range wanted {
				written, err := json.Marshal(route)
				if err != nil {
					return nil, nil, false, fmt.Errorf("encode caddy route: %w", err)
				}
				next = append(next, written)
			}
			for i, route := range routes {
				if !slices.ContainsFunc(wanted, func(w Route) bool { return w.ID == route.ID }) {
					next = append(next, raw[i])
				}
			}
		}
		secure := slices.ContainsFunc(skip, func(host string) bool { return slices.Contains(hosts, host) })
		if secure {
			skip = plainHosts(skip, nil, hosts)
		}
		changed = reorder || secure
		return next, skip, changed, nil
	})
	if err != nil {
		return false, fmt.Errorf("repair control plane routes: %w", err)
	}
	return changed, nil
}

// RouteID is the Caddy object id of a Shipkeep route.
func RouteID(routeID string) string {
	return idPrefix + routeID
}

// RouteName is the Shipkeep route id of a Caddy object id, when it is one.
func RouteName(id string) (string, bool) {
	return strings.CutPrefix(id, idPrefix)
}

// Routes lists the routes of the Shipkeep server, in order: none when it does not exist.
func (c *Client) Routes(ctx context.Context) ([]Route, error) {
	var routes []Route
	if _, err := c.get(ctx, "/config/apps/http/servers/"+Server+"/routes", &routes); err != nil && !errors.Is(err, errUnreachablePath) {
		return nil, fmt.Errorf("read caddy routes: %w", err)
	}
	return routes, nil
}

// EnsureServer creates the Shipkeep server when missing. It creates only the deepest missing
// level of apps/http/servers, never replaces existing configuration, and never uses /load (which
// would also reset the admin endpoint the installer configured on a Unix socket). On an existing
// server it secures the routes that older agents wrote (see secureRoutes).
func (c *Client) EnsureServer(ctx context.Context) error {
	body := server{Listen: []string{":80", ":443"}, Routes: []Route{}}
	levels := []struct {
		path  string
		child string
		value any
	}{
		{"/config/apps/http/servers/" + Server, "", nil},
		{"/config/apps/http/servers", Server, body},
		{"/config/apps/http", "servers", map[string]any{Server: body}},
		{"/config/apps", "http", map[string]any{"servers": map[string]any{Server: body}}},
		{"/config", "apps", map[string]any{"http": map[string]any{"servers": map[string]any{Server: body}}}},
	}
	for _, level := range levels {
		present, err := c.exists(ctx, level.path)
		if err != nil {
			return err
		}
		if !present {
			continue
		}
		if level.child == "" {
			return c.secureRoutes(ctx)
		}
		return c.do(ctx, http.MethodPut, level.path+"/"+level.child, level.value)
	}
	return errors.New("caddy has no configuration root; its admin endpoint is not configured by the installer")
}

// SecureRoutes secures the routes older agents wrote, as EnsureServer does, but creates nothing:
// without the Shipkeep server there is no route to secure.
func (c *Client) SecureRoutes(ctx context.Context) error {
	present, err := c.exists(ctx, "/config/apps/http/servers/"+Server)
	if err != nil || !present {
		return err
	}
	return c.secureRoutes(ctx)
}

// secureRoutes adds the HTTPS protocol matcher to the Shipkeep routes that lack it: agents up to
// 0.1.0-alpha.3 wrote routes that answered on plain HTTP instead of redirecting. A route whose
// hosts are all skipped by automatic HTTPS has TLS off and keeps answering on port 80. It also adds
// the Host bound (see hostBound) to the routes earlier agents wrote without it. Only the match of a
// route with the Shipkeep id prefix changes; other routes are never touched.
func (c *Client) secureRoutes(ctx context.Context) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	var routes []Route
	if _, err := c.get(ctx, "/config/apps/http/servers/"+Server+"/routes", &routes); err != nil {
		return fmt.Errorf("read caddy routes: %w", err)
	}
	var plain automaticHTTPS
	if _, err := c.get(ctx, "/config/apps/http/servers/"+Server+"/automatic_https", &plain); err != nil {
		return fmt.Errorf("read caddy automatic https: %w", err)
	}
	for _, route := range routes {
		if !strings.HasPrefix(route.ID, idPrefix) || len(route.Match) == 0 {
			continue
		}
		secured, changed := slices.Clone(route.Match), false
		for index, match := range secured {
			if !match.bounded() {
				secured[index].HeaderRegexp, changed = HostMatch(nil, "").HeaderRegexp, true
			}
			if match.Protocol != "" || len(match.Host) == 0 ||
				!slices.ContainsFunc(match.Host, func(host string) bool { return !slices.Contains(plain.Skip, host) }) {
				continue
			}
			secured[index].Protocol, changed = HTTPS, true
		}
		if changed {
			if err := c.do(ctx, http.MethodPatch, "/id/"+route.ID+"/match", secured); err != nil {
				return fmt.Errorf("secure caddy route: %w", err)
			}
		}
	}
	return nil
}

// UpsertRoute replaces the route with route.ID, or appends it. Caddy applies each change
// atomically and gracefully: in-flight requests finish on the old configuration.
func (c *Client) UpsertRoute(ctx context.Context, route Route) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	return c.upsertRoute(ctx, route)
}

// ApplyRoute writes a route and moves its hosts in or out of the hosts without TLS in one write of
// the Shipkeep server (#438): Caddy loads one configuration for the switch, and the route never
// disagrees with the TLS-off list. No other route change and no securing of old routes can
// interleave with it. A refused write leaves the previous configuration whole, so every host stays
// reachable.
func (c *Client) ApplyRoute(ctx context.Context, route Route, plainAdd, plainRemove []string) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	if !metricsSafe([]Route{route}) {
		// Per-host metrics stop before the route exists: see EnableRequestMetrics.
		if err := c.setPerHost(ctx, false); err != nil {
			return err
		}
	}
	written, err := json.Marshal(route)
	if err != nil {
		return fmt.Errorf("encode caddy route: %w", err)
	}
	err = c.writeServer(ctx, func(routes []json.RawMessage, skip []string) ([]json.RawMessage, []string, bool, error) {
		if at := routeIndex(routes, route.ID); at >= 0 {
			routes[at] = written
		} else {
			routes = append(routes, written)
		}
		return routes, plainHosts(skip, plainAdd, plainRemove), true, nil
	})
	if err != nil {
		return fmt.Errorf("apply route: %w", err)
	}
	return nil
}

func (c *Client) upsertRoute(ctx context.Context, route Route) error {
	if !metricsSafe([]Route{route}) {
		// Per-host metrics stop before the route exists: see EnableRequestMetrics.
		if err := c.setPerHost(ctx, false); err != nil {
			return err
		}
	}
	var stored json.RawMessage
	present, err := c.get(ctx, "/id/"+route.ID, &stored)
	if err != nil {
		return err
	}
	if present {
		return c.do(ctx, http.MethodPatch, "/id/"+route.ID, route)
	}
	return c.do(ctx, http.MethodPost, "/config/apps/http/servers/"+Server+"/routes", route)
}

// TLSHosts lists the host names the Shipkeep server serves over HTTPS, sorted and without
// duplicates. Wildcards are left out: no single certificate name answers for them.
func (c *Client) TLSHosts(ctx context.Context) ([]string, error) {
	var routes []Route
	if _, err := c.get(ctx, "/config/apps/http/servers/"+Server+"/routes", &routes); err != nil {
		return nil, fmt.Errorf("read caddy routes: %w", err)
	}
	hosts := []string{}
	for _, route := range routes {
		for _, match := range route.Match {
			if match.Protocol != HTTPS {
				continue
			}
			for _, host := range match.Host {
				if !strings.HasPrefix(host, "*.") && !slices.Contains(hosts, host) {
					hosts = append(hosts, host)
				}
			}
		}
	}
	slices.Sort(hosts)
	return hosts, nil
}

// UpdateRoute rewrites the route with this id as change returns it, holding the lock every
// read-then-write on routes takes, so that it never overwrites a route written in between. change
// gets the stored route and says whether to write the one it returns. An absent route is left
// alone.
func (c *Client) UpdateRoute(ctx context.Context, id string, change func(Route) (Route, bool)) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	route, present, err := c.Route(ctx, id)
	if err != nil || !present {
		return err
	}
	updated, write := change(route)
	if !write {
		return nil
	}
	return c.upsertRoute(ctx, updated)
}

// Route returns the stored route with id, if any.
func (c *Client) Route(ctx context.Context, id string) (Route, bool, error) {
	var route Route
	present, err := c.get(ctx, "/id/"+id, &route)
	return route, present, err
}

// RemoveRoute deletes a route and takes plainRemove out of the hosts without TLS, in one write of
// the Shipkeep server (#438). A missing route is already removed: with no host to take out either,
// nothing is written.
func (c *Client) RemoveRoute(ctx context.Context, id string, plainRemove []string) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	return c.writeServer(ctx, func(routes []json.RawMessage, skip []string) ([]json.RawMessage, []string, bool, error) {
		kept := plainHosts(skip, nil, plainRemove)
		at := routeIndex(routes, id)
		if at >= 0 {
			routes = slices.Delete(routes, at, at+1)
		}
		return routes, kept, at >= 0 || !slices.Equal(kept, plainHosts(skip, nil, nil)), nil
	})
}

// errChanged is Caddy's 412 to a write whose If-Match no longer holds: the configuration changed
// after it was read.
var errChanged = errors.New("caddy: the configuration changed meanwhile")

// serverWrites bounds the attempts of one server write that a change in between refused.
const serverWrites = 3

// writeServer reads the Shipkeep server, lets change rewrite its routes and its hosts without TLS,
// and writes it back in one request, so that Caddy loads one configuration for the whole change:
// each load closes the previous one's idle connections, and a client that sends on one of them at
// that instant gets a reset (#437). The server's other fields are kept as they are. The write
// carries the read's ETag (If-Match), and is made again from a new read when the configuration
// changed in between. change reports whether there is anything to write.
func (c *Client) writeServer(ctx context.Context, change func(routes []json.RawMessage, skip []string) ([]json.RawMessage, []string, bool, error)) error {
	path := "/config/apps/http/servers/" + Server
	for attempt := 1; ; attempt++ {
		var stored map[string]json.RawMessage
		etag, present, err := c.getTagged(ctx, path, &stored)
		if err != nil {
			return err
		}
		if !present {
			return errors.New("caddy has no shipkeep server")
		}
		var routes []json.RawMessage
		if err := decodeField(stored, "routes", &routes); err != nil {
			return err
		}
		automatic := map[string]json.RawMessage{}
		if err := decodeField(stored, "automatic_https", &automatic); err != nil {
			return err
		}
		var skip []string
		if err := decodeField(automatic, "skip", &skip); err != nil {
			return err
		}
		routes, skip, changed, err := change(routes, skip)
		if err != nil || !changed {
			return err
		}
		if err := setField(stored, "routes", routes, len(routes) > 0); err != nil {
			return err
		}
		if err := setField(automatic, "skip", skip, len(skip) > 0); err != nil {
			return err
		}
		if err := setField(stored, "automatic_https", automatic, len(automatic) > 0); err != nil {
			return err
		}
		_, err = c.send(ctx, http.MethodPatch, path, stored, etag, nil)
		if !errors.Is(err, errChanged) || attempt == serverWrites {
			return err
		}
	}
}

// plainHosts is skip without remove and with add, sorted and without duplicates.
func plainHosts(skip, add, remove []string) []string {
	hosts := slices.DeleteFunc(slices.Clone(skip), func(host string) bool { return slices.Contains(remove, host) })
	for _, host := range add {
		if !slices.Contains(hosts, host) {
			hosts = append(hosts, host)
		}
	}
	slices.Sort(hosts)
	return slices.Compact(hosts)
}

// routeIndex is the position of the route with this id in routes, or -1.
func routeIndex(routes []json.RawMessage, id string) int {
	return slices.IndexFunc(routes, func(raw json.RawMessage) bool {
		var route struct {
			ID string `json:"@id"`
		}
		return json.Unmarshal(raw, &route) == nil && route.ID == id
	})
}

// decodeField reads object[name] into out; an absent or null field leaves out as it is.
func decodeField(object map[string]json.RawMessage, name string, out any) error {
	raw, ok := object[name]
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode caddy %s: %w", name, err)
	}
	return nil
}

// setField writes value as object[name], or removes the field when keep is false.
func setField(object map[string]json.RawMessage, name string, value any, keep bool) error {
	if !keep {
		delete(object, name)
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode caddy %s: %w", name, err)
	}
	object[name] = raw
	return nil
}

// errUnreachablePath is Caddy's 400 to a read: a parent of the path does not exist.
var errUnreachablePath = errors.New("caddy GET: status 400")

// exists reports whether a config path holds a value. A path below a missing parent does not.
func (c *Client) exists(ctx context.Context, path string) (bool, error) {
	var value json.RawMessage
	present, err := c.get(ctx, path, &value)
	if errors.Is(err, errUnreachablePath) {
		return false, nil
	}
	return present, err
}

func (c *Client) get(ctx context.Context, path string, out any) (bool, error) {
	_, present, err := c.getTagged(ctx, path, out)
	return present, err
}

// getTagged is get, with the ETag Caddy answered: what a write of the same path sends as If-Match.
func (c *Client) getTagged(ctx context.Context, path string, out any) (string, bool, error) {
	var raw json.RawMessage
	etag, err := c.send(ctx, http.MethodGet, path, nil, "", &raw)
	if errors.Is(err, ErrNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return etag, false, nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return "", false, fmt.Errorf("decode caddy response: %w", err)
	}
	return etag, true, nil
}

// EnableRequestMetrics turns Caddy's request metrics per host name on (ADR 0024) when every route
// of every HTTP server bounds its hosts, and off otherwise; it reports whether they are on. The
// setting applies to all of Caddy's HTTP servers, not only Shipkeep's. A route that lacks the Host
// bound (written by an older agent, until secureRoutes adds it, or by someone else), that has no
// host list, or that has a wildcard host lets clients choose the label, so per-host metrics would
// have no limit.
func (c *Client) EnableRequestMetrics(ctx context.Context) (bool, error) {
	c.routes.Lock()
	defer c.routes.Unlock()
	var servers map[string]struct {
		Routes []Route `json:"routes"`
	}
	if _, err := c.get(ctx, "/config/apps/http/servers", &servers); err != nil {
		return false, fmt.Errorf("read caddy servers: %w", err)
	}
	on := len(servers) > 0
	for _, server := range servers {
		on = on && metricsSafe(server.Routes)
	}
	if err := c.setPerHost(ctx, on); err != nil {
		return false, err
	}
	return on, nil
}

// metricsSafe tells whether routes keep per-host metrics bounded. It fails closed: each route has
// matchers, and each matcher set names literal hosts (see literalHost) and bounds the Host header.
// A route without matchers answers every request, an invented port included.
func metricsSafe(routes []Route) bool {
	for _, route := range routes {
		if len(route.Match) == 0 {
			return false
		}
		for _, match := range route.Match {
			if !match.bounded() || len(match.Host) == 0 ||
				slices.ContainsFunc(match.Host, func(host string) bool { return !literalHost(host) }) {
				return false
			}
		}
	}
	return true
}

// literalHost tells whether a host matcher names one host: letters, digits, dots and hyphens only.
// A wildcard or a placeholder such as {http.request.host} matches names a client invents.
func literalHost(host string) bool {
	return host != "" && strings.Trim(host, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-") == ""
}

// setPerHost writes Caddy's per_host metrics setting when it differs, and only that key, so any
// other metrics setting stays as it is.
func (c *Client) setPerHost(ctx context.Context, on bool) error {
	var current map[string]json.RawMessage
	found, err := c.get(ctx, "/config/apps/http/metrics", &current)
	if err != nil {
		return fmt.Errorf("read caddy metrics settings: %w", err)
	}
	isOn := string(bytes.TrimSpace(current["per_host"])) == "true"
	switch {
	case isOn == on:
		return nil
	case !found && on:
		err = c.do(ctx, http.MethodPut, "/config/apps/http/metrics", map[string]bool{"per_host": true})
	case !found:
		return nil
	default:
		// POST sets one key of an object, whether it is there or not; PATCH would need it there.
		err = c.do(ctx, http.MethodPost, "/config/apps/http/metrics/per_host", on)
	}
	if err != nil {
		return fmt.Errorf("set caddy request metrics: %w", err)
	}
	return nil
}

// RequestMetrics returns Caddy's metrics, in the Prometheus text format, at most maxBody bytes.
func (c *Client) RequestMetrics(ctx context.Context) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://caddy/metrics", nil)
	if err != nil {
		return nil, fmt.Errorf("build caddy request: %w", err)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("caddy GET: %w", err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("caddy GET: status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("read caddy metrics: %w", err)
	}
	if len(data) > maxBody {
		return nil, errors.New("caddy metrics too large")
	}
	return data, nil
}

func (c *Client) do(ctx context.Context, method, path string, body any) error {
	_, err := c.send(ctx, method, path, body, "", nil)
	return err
}

// send makes one admin request and answers Caddy's ETag. A write with ifMatch is made only if the
// configuration at path is still the one with that ETag.
func (c *Client) send(ctx context.Context, method, path string, body any, ifMatch string, out any) (string, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return "", fmt.Errorf("encode caddy request: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://caddy"+path, reader)
	if err != nil {
		return "", fmt.Errorf("build caddy request: %w", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if ifMatch != "" {
		request.Header.Set("If-Match", ifMatch)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return "", fmt.Errorf("caddy %s: %w", method, err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if err != nil {
		return "", fmt.Errorf("read caddy response: %w", err)
	}
	if len(data) > maxBody {
		return "", errors.New("caddy response too large")
	}
	etag := response.Header.Get("Etag")
	switch {
	case response.StatusCode == http.StatusNotFound:
		return "", ErrNotFound
	case response.StatusCode == http.StatusPreconditionFailed:
		return "", errChanged
	case response.StatusCode == http.StatusBadRequest && method == http.MethodGet:
		// Caddy answers a read below a missing parent ("invalid traversal path") with 400, not 404.
		// Only EnsureServer, which walks up to the first existing level, reads this as "missing".
		return "", errUnreachablePath
	case response.StatusCode/100 != 2:
		// Caddy error text can contain configuration: report the status only.
		return "", fmt.Errorf("caddy %s: status %d", method, response.StatusCode)
	case out == nil || len(data) == 0:
		return etag, nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return "", fmt.Errorf("decode caddy response: %w", err)
	}
	return etag, nil
}
