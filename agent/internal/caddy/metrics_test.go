package caddy

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// metricsAdmin answers the paths of the request metrics as Caddy does: null for a setting not
// there, the settings once written, the metrics text, and the routes of the Shipkeep server.
type metricsAdmin struct {
	mu     sync.Mutex
	routes string
	// others adds servers to the HTTP app, as `,"name":{...}`.
	others   string
	settings string
	text     string
	status   int
	writes   []string
}

func (m *metricsAdmin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps/http/servers":
		routes := m.routes
		if routes == "" {
			routes = "[]"
		}
		_, _ = w.Write([]byte(`{"` + Server + `":{"routes":` + routes + `}` + m.others + `}`))
	case r.URL.Path == "/metrics":
		if m.status != 0 {
			w.WriteHeader(m.status)
		}
		_, _ = w.Write([]byte(m.text))
	case r.Method == http.MethodGet && r.URL.Path == "/config/apps/http/metrics":
		if m.settings == "" {
			_, _ = w.Write([]byte("null"))
			return
		}
		_, _ = w.Write([]byte(m.settings))
	case r.URL.Path == "/config/apps/http/metrics":
		m.writes = append(m.writes, r.Method)
		m.settings = strings.TrimSpace(string(body))
	case r.Method == http.MethodPost && r.URL.Path == "/config/apps/http/metrics/per_host":
		// Caddy sets that one key and keeps the others.
		m.writes = append(m.writes, "POST per_host")
		settings := map[string]json.RawMessage{}
		_ = json.Unmarshal([]byte(m.settings), &settings)
		settings["per_host"] = json.RawMessage(strings.TrimSpace(string(body)))
		out, _ := json.Marshal(settings)
		m.settings = string(out)
	default:
		http.Error(w, "unexpected", http.StatusBadRequest)
	}
}

func metricsClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	dir, err := os.MkdirTemp("", "sk-caddy")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "admin.sock")
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", path)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler} //nolint:gosec // test server on a private socket
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	client, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func routesJSON(t *testing.T, routes ...Route) string {
	t.Helper()
	data, err := json.Marshal(routes)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// Per-host metrics are turned on once: created when missing, corrected when off, left alone when on;
// correcting them keeps every other metrics setting.
func TestEnablesPerHostRequestMetricsOnce(t *testing.T) {
	admin := &metricsAdmin{}
	client := metricsClient(t, admin)
	admin.routes = routesJSON(t, Route{ID: RouteID("a"), Match: []Match{HostMatch([]string{"shop.example.com"}, HTTPS)}})
	for range 3 {
		if on, err := client.EnableRequestMetrics(t.Context()); err != nil || !on {
			t.Fatalf("on = %v, err = %v", on, err)
		}
	}
	if len(admin.writes) != 1 || admin.writes[0] != http.MethodPut || admin.settings != `{"per_host":true}` {
		t.Fatalf("writes %v, settings %s", admin.writes, admin.settings)
	}
	admin.settings = `{"otlp":true,"per_host":false}`
	if _, err := client.EnableRequestMetrics(t.Context()); err != nil {
		t.Fatal(err)
	}
	if admin.writes[1] != "POST per_host" || admin.settings != `{"otlp":true,"per_host":true}` {
		t.Fatalf("writes %v, settings %s", admin.writes, admin.settings)
	}
	admin.settings = `{"otlp":true}`
	if _, err := client.EnableRequestMetrics(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(admin.writes) != 3 || admin.settings != `{"otlp":true,"per_host":true}` {
		t.Fatalf("writes %v, settings %s", admin.writes, admin.settings)
	}
}

// A route that lets a client choose the host label turns per-host metrics off: one without the
// Host bound, as older agents wrote them, one with a wildcard host, one without matchers or hosts
// (it answers any Host). Nothing is created to say off.
func TestKeepsPerHostMetricsOffForUnboundedRoutes(t *testing.T) {
	for name, route := range map[string]Route{
		"no host bound": {ID: RouteID("old"), Match: []Match{{Host: []string{"shop.example.com"}, Protocol: HTTPS}}},
		"another bound": {ID: RouteID("odd"), Match: []Match{{Host: []string{"shop.example.com"}, HeaderRegexp: map[string]HeaderPattern{"Host": {Pattern: ".*"}}}}},
		"a wildcard":    {ID: RouteID("wild"), Match: []Match{HostMatch([]string{"*.example.com"}, HTTPS)}},
		"no matcher":    {ID: "fallback"},
		"no host":       {ID: "hostless", Match: []Match{HostMatch(nil, HTTPS)}},
	} {
		admin := &metricsAdmin{settings: `{"otlp":true,"per_host":true}`}
		client := metricsClient(t, admin)
		admin.routes = routesJSON(t, Route{ID: RouteID("ok"), Match: []Match{HostMatch([]string{"a.example.com"}, HTTPS)}}, route)
		if on, err := client.EnableRequestMetrics(t.Context()); err != nil || on {
			t.Fatalf("%s: on = %v, err = %v", name, on, err)
		}
		if admin.settings != `{"otlp":true,"per_host":false}` {
			t.Fatalf("%s: settings %s", name, admin.settings)
		}
		missing := &metricsAdmin{routes: admin.routes}
		if on, err := metricsClient(t, missing).EnableRequestMetrics(t.Context()); err != nil || on || len(missing.writes) != 0 {
			t.Fatalf("%s: on = %v, err = %v, writes %v", name, on, err, missing.writes)
		}
	}
}

func TestReadsTheMetricsTextWithinItsBound(t *testing.T) {
	admin := &metricsAdmin{text: "caddy_http_requests_total{host=\"a.example.com\"} 1\n"}
	client := metricsClient(t, admin)
	text, err := client.RequestMetrics(t.Context())
	if err != nil || string(text) != admin.text {
		t.Fatalf("text %q, err %v", text, err)
	}
	admin.text = strings.Repeat("x", maxBody+1)
	if _, err := client.RequestMetrics(t.Context()); err == nil {
		t.Fatal("an oversized answer was read")
	}
	admin.text, admin.status = "private detail", http.StatusInternalServerError
	if _, err := client.RequestMetrics(t.Context()); err == nil || strings.Contains(err.Error(), "private detail") {
		t.Fatalf("err = %v", err)
	}
}

// Caddy applies per_host to every HTTP server: an unbounded route on another server keeps it off.
func TestKeepsPerHostMetricsOffForAnotherServer(t *testing.T) {
	admin := &metricsAdmin{settings: `{"per_host":true}`}
	client := metricsClient(t, admin)
	admin.routes = routesJSON(t, Route{ID: RouteID("ok"), Match: []Match{HostMatch([]string{"a.example.com"}, HTTPS)}})
	admin.others = `,"other":{"routes":[{"match":[{"host":["b.example.com"]}],"handle":[]}]}`
	if on, err := client.EnableRequestMetrics(t.Context()); err != nil || on || admin.settings != `{"per_host":false}` {
		t.Fatalf("on = %v, err = %v, settings %s", on, err, admin.settings)
	}
	admin.others = `,"other":{"routes":[` + routesJSON(t, Route{ID: "b", Match: []Match{HostMatch([]string{"b.example.com"}, HTTPS)}})[1:]
	admin.others = admin.others[:len(admin.others)-1] + `]}`
	if on, err := client.EnableRequestMetrics(t.Context()); err != nil || !on {
		t.Fatalf("bounded routes on both servers: on = %v, err = %v", on, err)
	}
}
