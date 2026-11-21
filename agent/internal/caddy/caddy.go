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
	// betweenWrites, nil outside tests, runs in ApplyRoute after the route is written and before
	// its hosts join the TLS-off list, with the lock held.
	betweenWrites func()
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

// Handler is a reverse_proxy handler, or the static_response of the control plane's redirect.
type Handler struct {
	Handler       string         `json:"handler"`
	Upstreams     []Upstream     `json:"upstreams,omitempty"`
	LoadBalancing *LoadBalancing `json:"load_balancing,omitempty"`
	// StatusCode and Headers belong to a static_response.
	StatusCode int                 `json:"status_code,omitempty"`
	Headers    map[string][]string `json:"headers,omitempty"`
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
	ControlPlaneRouteID         = "shipkeep-control-plane"
	ControlPlaneRedirectRouteID = "shipkeep-control-plane-http"
)

// ControlPlaneRoutes are the routes of the control plane's name: HTTPS to its loopback port, and
// plain HTTP redirected to HTTPS. The redirect is a route of its own, so that no application route
// placed after it answers that name on HTTP, not even a wildcard with TLS off.
func ControlPlaneRoutes(host, upstream string) []Route {
	return []Route{
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
	path := "/config/apps/http/servers/" + Server + "/routes"
	// The other routes are kept as Caddy returned them, so that fields this client does not model
	// survive the rewrite.
	var raw []json.RawMessage
	if _, err := c.get(ctx, path, &raw); err != nil {
		return false, fmt.Errorf("read caddy routes: %w", err)
	}
	routes := make([]Route, len(raw))
	for i := range raw {
		if err := json.Unmarshal(raw[i], &routes[i]); err != nil {
			return false, fmt.Errorf("decode caddy route: %w", err)
		}
	}
	changed := false
	if len(routes) < len(wanted) || !reflect.DeepEqual(routes[:len(wanted)], wanted) {
		// One PATCH replaces the whole list: Caddy applies it at once, so no intermediate
		// configuration lacks the fixed routes and lets an application route answer for the host.
		next := make([]any, 0, len(raw)+len(wanted))
		for _, route := range wanted {
			next = append(next, route)
		}
		for i, route := range routes {
			if !slices.ContainsFunc(wanted, func(w Route) bool { return w.ID == route.ID }) {
				next = append(next, raw[i])
			}
		}
		if err := c.do(ctx, http.MethodPatch, path, next, nil); err != nil {
			return false, fmt.Errorf("replace caddy routes: %w", err)
		}
		changed = true
	}
	var plain automaticHTTPS
	if _, err := c.get(ctx, "/config/apps/http/servers/"+Server+"/automatic_https", &plain); err != nil {
		return changed, fmt.Errorf("read caddy automatic https: %w", err)
	}
	hosts := wanted[0].Match[0].Host
	if slices.ContainsFunc(plain.Skip, func(host string) bool { return slices.Contains(hosts, host) }) {
		if err := c.setPlainHosts(ctx, nil, hosts); err != nil {
			return changed, fmt.Errorf("serve control plane over https: %w", err)
		}
		changed = true
	}
	return changed, nil
}

// RouteID is the Caddy object id of a Shipkeep route.
func RouteID(routeID string) string {
	return idPrefix + routeID
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
		return c.do(ctx, http.MethodPut, level.path+"/"+level.child, level.value, nil)
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
			if err := c.do(ctx, http.MethodPatch, "/id/"+route.ID+"/match", secured, nil); err != nil {
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

// ApplyRoute writes a route and moves its hosts in or out of the hosts without TLS, as one unit
// that no other route change and no securing of old routes can interleave with. The order keeps
// every host reachable if a write fails: hosts leave the TLS-off list before the route changes
// (until then the old route still answers them, now with a certificate), and join it only after
// the route answers plain HTTP. The other order could leave a host without a certificate behind a
// route that answers HTTPS only.
func (c *Client) ApplyRoute(ctx context.Context, route Route, plainAdd, plainRemove []string) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	if err := c.setPlainHosts(ctx, nil, plainRemove); err != nil {
		return fmt.Errorf("set plain hosts: %w", err)
	}
	if err := c.upsertRoute(ctx, route); err != nil {
		return fmt.Errorf("upsert route: %w", err)
	}
	if c.betweenWrites != nil {
		c.betweenWrites()
	}
	if err := c.setPlainHosts(ctx, plainAdd, nil); err != nil {
		return fmt.Errorf("set plain hosts: %w", err)
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
		return c.do(ctx, http.MethodPatch, "/id/"+route.ID, route, nil)
	}
	return c.do(ctx, http.MethodPost, "/config/apps/http/servers/"+Server+"/routes", route, nil)
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

// Route returns the stored route with id, if any.
func (c *Client) Route(ctx context.Context, id string) (Route, bool, error) {
	var route Route
	present, err := c.get(ctx, "/id/"+id, &route)
	return route, present, err
}

// RemoveRoute deletes a route; a missing route is already removed.
func (c *Client) RemoveRoute(ctx context.Context, id string) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	err := c.do(ctx, http.MethodDelete, "/id/"+id, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// SetPlainHosts adds or removes hosts from automatic HTTPS (TLS mode off).
func (c *Client) SetPlainHosts(ctx context.Context, add, remove []string) error {
	c.routes.Lock()
	defer c.routes.Unlock()
	return c.setPlainHosts(ctx, add, remove)
}

func (c *Client) setPlainHosts(ctx context.Context, add, remove []string) error {
	path := "/config/apps/http/servers/" + Server + "/automatic_https"
	var current automaticHTTPS
	present, err := c.get(ctx, path, &current)
	if err != nil {
		return err
	}
	skip := slices.DeleteFunc(slices.Clone(current.Skip), func(host string) bool { return slices.Contains(remove, host) })
	for _, host := range add {
		if !slices.Contains(skip, host) {
			skip = append(skip, host)
		}
	}
	slices.Sort(skip)
	if !present {
		if len(skip) == 0 {
			return nil
		}
		return c.do(ctx, http.MethodPut, path, automaticHTTPS{Skip: skip}, nil)
	}
	return c.do(ctx, http.MethodPatch, path, automaticHTTPS{Skip: skip}, nil)
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
	var raw json.RawMessage
	err := c.do(ctx, http.MethodGet, path, nil, &raw)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return false, nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, fmt.Errorf("decode caddy response: %w", err)
	}
	return true, nil
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
		err = c.do(ctx, http.MethodPut, "/config/apps/http/metrics", map[string]bool{"per_host": true}, nil)
	case !found:
		return nil
	default:
		// POST sets one key of an object, whether it is there or not; PATCH would need it there.
		err = c.do(ctx, http.MethodPost, "/config/apps/http/metrics/per_host", on, nil)
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

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode caddy request: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://caddy"+path, reader)
	if err != nil {
		return fmt.Errorf("build caddy request: %w", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("caddy %s: %w", method, err)
	}
	defer response.Body.Close() //nolint:errcheck // read-only body
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBody+1))
	if err != nil {
		return fmt.Errorf("read caddy response: %w", err)
	}
	if len(data) > maxBody {
		return errors.New("caddy response too large")
	}
	switch {
	case response.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case response.StatusCode == http.StatusBadRequest && method == http.MethodGet:
		// Caddy answers a read below a missing parent ("invalid traversal path") with 400, not 404.
		// Only EnsureServer, which walks up to the first existing level, reads this as "missing".
		return errUnreachablePath
	case response.StatusCode/100 != 2:
		// Caddy error text can contain configuration: report the status only.
		return fmt.Errorf("caddy %s: status %d", method, response.StatusCode)
	case out == nil || len(data) == 0:
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode caddy response: %w", err)
	}
	return nil
}
