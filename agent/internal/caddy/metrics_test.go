package caddy

import (
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
// there, the settings once written, and the metrics text.
type metricsAdmin struct {
	mu       sync.Mutex
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

// Per-host metrics are turned on once: created when missing, corrected when off, left alone when on.
func TestEnablesPerHostRequestMetricsOnce(t *testing.T) {
	admin := &metricsAdmin{}
	client := metricsClient(t, admin)
	for range 3 {
		if err := client.EnableRequestMetrics(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if len(admin.writes) != 1 || admin.writes[0] != http.MethodPut || admin.settings != `{"per_host":true}` {
		t.Fatalf("writes %v, settings %s", admin.writes, admin.settings)
	}
	admin.settings = `{"per_host":false}`
	if err := client.EnableRequestMetrics(t.Context()); err != nil {
		t.Fatal(err)
	}
	if admin.writes[1] != http.MethodPatch || admin.settings != `{"per_host":true}` {
		t.Fatalf("writes %v, settings %s", admin.writes, admin.settings)
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
