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
	"slices"
	"strings"
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

// Match selects requests by host.
type Match struct {
	Host []string `json:"host"`
}

// Handler is a reverse_proxy handler.
type Handler struct {
	Handler       string         `json:"handler"`
	Upstreams     []Upstream     `json:"upstreams"`
	LoadBalancing *LoadBalancing `json:"load_balancing,omitempty"`
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

// RouteID is the Caddy object id of a Shipkeep route.
func RouteID(routeID string) string {
	return idPrefix + routeID
}

// EnsureServer creates the Shipkeep server when missing. It creates only the deepest missing
// level of apps/http/servers, never replaces existing configuration, and never uses /load (which
// would also reset the admin endpoint the installer configured on a Unix socket).
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
			return nil
		}
		return c.do(ctx, http.MethodPut, level.path+"/"+level.child, level.value, nil)
	}
	return errors.New("caddy has no configuration root; its admin endpoint is not configured by the installer")
}

// UpsertRoute replaces the route with route.ID, or appends it. Caddy applies each change
// atomically and gracefully: in-flight requests finish on the old configuration.
func (c *Client) UpsertRoute(ctx context.Context, route Route) error {
	present, err := c.exists(ctx, "/id/"+route.ID)
	if err != nil {
		return err
	}
	if present {
		return c.do(ctx, http.MethodPatch, "/id/"+route.ID, route, nil)
	}
	return c.do(ctx, http.MethodPost, "/config/apps/http/servers/"+Server+"/routes", route, nil)
}

// Route returns the stored route with id, if any.
func (c *Client) Route(ctx context.Context, id string) (Route, bool, error) {
	var route Route
	present, err := c.get(ctx, "/id/"+id, &route)
	return route, present, err
}

// RemoveRoute deletes a route; a missing route is already removed.
func (c *Client) RemoveRoute(ctx context.Context, id string) error {
	err := c.do(ctx, http.MethodDelete, "/id/"+id, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// SetPlainHosts adds or removes hosts from automatic HTTPS (TLS mode off).
func (c *Client) SetPlainHosts(ctx context.Context, add, remove []string) error {
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

// exists reports whether a config path or object id holds a value.
func (c *Client) exists(ctx context.Context, path string) (bool, error) {
	var value json.RawMessage
	return c.get(ctx, path, &value)
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
