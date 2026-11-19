package egress

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

// public stands for an address on the internet; the test dialer sends it to a local echo server.
var public = netip.MustParseAddr("8.8.8.8")

type harness struct {
	address string
	logs    *bytes.Buffer
	mu      sync.Mutex
	dialed  []netip.AddrPort
}

func (h *harness) dials() []netip.AddrPort {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]netip.AddrPort(nil), h.dialed...)
}

// start runs a proxy whose resolver answers from names, and whose dialer reaches echo for the
// public address only.
func start(t *testing.T, limits Limits, names map[string][]string) *harness {
	t.Helper()
	echo := listen(t)
	t.Cleanup(func() { _ = echo.Close() })
	go func() {
		for {
			conn, err := echo.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(conn, conn); _ = conn.Close() }()
		}
	}()
	h := &harness{logs: &bytes.Buffer{}}
	var logMu sync.Mutex
	proxy := &Proxy{
		Logger: slog.New(slog.NewJSONHandler(lockedWriter{&logMu, h.logs}, nil)),
		Limits: limits,
		Resolve: func(_ context.Context, host string) ([]netip.Addr, error) {
			answers, ok := names[host]
			if !ok {
				return nil, errors.New("no such host")
			}
			var out []netip.Addr
			for _, answer := range answers {
				out = append(out, netip.MustParseAddr(answer))
			}
			return out, nil
		},
		dial: func(ctx context.Context, address netip.AddrPort) (net.Conn, error) {
			h.mu.Lock()
			h.dialed = append(h.dialed, address)
			h.mu.Unlock()
			if address.Addr() != public {
				return nil, errors.New("unreachable in the test")
			}
			var dialer net.Dialer
			return dialer.DialContext(ctx, "tcp", echo.Addr().String())
		},
	}
	listener := listen(t)
	ctx, cancel := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- proxy.Serve(ctx, listener) }()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("serve: %v", err)
		}
	})
	h.address = listener.Addr().String()
	return h
}

func listen(t *testing.T) net.Listener {
	t.Helper()
	var config net.ListenConfig
	listener, err := config.Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return listener
}

type lockedWriter struct {
	mu *sync.Mutex
	w  io.Writer
}

func (l lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// request sends a raw request and returns the status code and the open connection.
func request(t *testing.T, h *harness, raw string) (int, net.Conn, *bufio.Reader) {
	t.Helper()
	dialer := net.Dialer{Timeout: 2 * time.Second}
	conn, err := dialer.DialContext(context.Background(), "tcp", h.address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	// The body of a refusal is short and read here; a tunnel has none, and the connection stays
	// open for it.
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, response.Body)
	}
	_ = response.Body.Close()
	return response.StatusCode, conn, reader
}

func connect(t *testing.T, h *harness, authority string) (int, net.Conn, *bufio.Reader) {
	t.Helper()
	return request(t, h, fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority))
}

func TestTunnelsToAPublicAddress(t *testing.T) {
	h := start(t, DefaultLimits, map[string][]string{"registry.example.com": {"8.8.8.8"}})
	status, conn, reader := connect(t, h, "registry.example.com:443")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	if _, err := conn.Write([]byte("ping\n")); err != nil {
		t.Fatal(err)
	}
	line, err := reader.ReadString('\n')
	if err != nil || line != "ping\n" {
		t.Fatalf("echo %q %v", line, err)
	}
	// An IP literal that is public goes through too.
	if status, _, _ := connect(t, h, "8.8.8.8:5000"); status != http.StatusOK {
		t.Fatalf("public literal: %d", status)
	}
}

func TestRefusesDestinationsThatAreNotPublic(t *testing.T) {
	names := map[string][]string{
		"loopback.example.com": {"127.0.0.1"},
		"private.example.com":  {"192.168.208.3"},
		"metadata.example.com": {"169.254.169.254"},
		"mixed.example.com":    {"8.8.8.8", "10.0.0.5"}, // one private answer is enough
		"mapped.example.com":   {"::ffff:127.0.0.1"},
		"nat64.example.com":    {"64:ff9b::a9fe:a9fe"},
		"v6.example.com":       {"::1"},
	}
	h := start(t, DefaultLimits, names)
	for _, authority := range []string{
		"loopback.example.com:443", "private.example.com:5443", "metadata.example.com:80",
		"mixed.example.com:443", "mapped.example.com:443", "nat64.example.com:443", "v6.example.com:443",
		"127.0.0.1:7480", "[::1]:7480", "10.0.0.1:443", "169.254.169.254:80", "[::ffff:127.0.0.1]:443",
	} {
		if status, _, _ := connect(t, h, authority); status != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", authority, status)
		}
	}
	if dialed := h.dials(); len(dialed) != 0 {
		t.Fatalf("dialed %v", dialed)
	}
}

func TestRefusesPlainHTTPWithoutForwardingIt(t *testing.T) {
	h := start(t, DefaultLimits, map[string][]string{"registry.example.com": {"8.8.8.8"}})
	for _, raw := range []string{
		"GET http://registry.example.com/v2/ HTTP/1.1\r\nHost: registry.example.com\r\n\r\n",
		"GET http://127.0.0.1:8099/token?scope=x HTTP/1.1\r\nHost: 127.0.0.1:8099\r\n\r\n",
		"POST http://registry.example.com/ HTTP/1.1\r\nHost: registry.example.com\r\nContent-Length: 0\r\n\r\n",
		"GET / HTTP/1.1\r\nHost: registry.example.com\r\n\r\n",
	} {
		if status, _, _ := request(t, h, raw); status != http.StatusForbidden {
			t.Errorf("%q: status %d", raw[:20], status)
		}
	}
	if dialed := h.dials(); len(dialed) != 0 {
		t.Fatalf("dialed %v", dialed)
	}
}

func TestRefusesMalformedTargets(t *testing.T) {
	h := start(t, DefaultLimits, map[string][]string{"registry.example.com": {"8.8.8.8"}})
	for _, authority := range []string{
		"registry.example.com", "registry.example.com:0", "registry.example.com:65536",
		"registry.example.com:+443", "registry.example.com:0443", ":443",
		"reg_istry.example.com:443", "registry..example.com:443", "-." + strings.Repeat("a", 64) + ".com:443",
		strings.Repeat("a.", 130) + "com:443", "[fe80::1%25eth0]:443", "registry.example.com:443/../x",
	} {
		status, _, _ := request(t, h, fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", authority, authority))
		if status != http.StatusBadRequest && status != http.StatusForbidden {
			t.Errorf("%q: status %d", authority, status)
		}
	}
	if dialed := h.dials(); len(dialed) != 0 {
		t.Fatalf("dialed %v", dialed)
	}
}

func TestBoundsTunnelsAndTheirLifetime(t *testing.T) {
	h := start(t, Limits{Tunnels: 1, Connect: time.Second, Lifetime: 300 * time.Millisecond}, map[string][]string{"registry.example.com": {"8.8.8.8"}})
	status, held, reader := connect(t, h, "registry.example.com:443")
	if status != http.StatusOK {
		t.Fatalf("first: %d", status)
	}
	if status, _, _ := connect(t, h, "registry.example.com:443"); status != http.StatusServiceUnavailable {
		t.Fatalf("second while the first is open: %d", status)
	}
	// The first tunnel ends with its lifetime, which frees its place.
	_ = held.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := reader.ReadByte(); err == nil {
		t.Fatal("tunnel still open after its lifetime")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		status, _, _ := connect(t, h, "registry.example.com:443")
		if status == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("place never freed: %d", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLogsHostsAndOutcomesOnly(t *testing.T) {
	h := start(t, DefaultLimits, map[string][]string{"registry.example.com": {"8.8.8.8"}, "private.example.com": {"10.0.0.5"}})
	request(t, h, "CONNECT registry.example.com:443 HTTP/1.1\r\nHost: registry.example.com:443\r\nProxy-Authorization: Basic c2VjcmV0LXZhbHVl\r\n\r\n")
	request(t, h, "CONNECT private.example.com:443 HTTP/1.1\r\nHost: private.example.com:443\r\n\r\n")
	request(t, h, "GET http://private.example.com/secret-path?token=abc HTTP/1.1\r\nHost: private.example.com\r\n\r\n")
	time.Sleep(50 * time.Millisecond)
	logs := h.logs.String()
	for _, want := range []string{`"host":"registry.example.com"`, `"reason":"not_public"`, `"reason":"not_connect"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs miss %s:\n%s", want, logs)
		}
	}
	for _, never := range []string{"c2VjcmV0LXZhbHVl", "secret-path", "token=abc"} {
		if strings.Contains(logs, never) {
			t.Errorf("logs contain %q", never)
		}
	}
}

// The dialer's last check runs on the address the socket connects to.
func TestGuardChecksTheAddressItConnectsTo(t *testing.T) {
	for address, allowed := range map[string]bool{
		"8.8.8.8:443":             true,
		"[2606:4700::1111]:443":   true,
		"127.0.0.1:7480":          false,
		"[::1]:7480":              false,
		"10.0.0.5:443":            false,
		"169.254.169.254:80":      false,
		"[::ffff:127.0.0.1]:443":  false,
		"[64:ff9b::a9fe:a9fe]:80": false,
		"not-an-address:443":      false,
	} {
		if err := guard("tcp4", address, nil); (err == nil) != allowed {
			t.Errorf("guard(%s) = %v", address, err)
		}
	}
	// With the real dialer, a loopback listener is refused before any connection.
	listener := listen(t)
	defer listener.Close() //nolint:errcheck // test listener
	accepted := make(chan struct{}, 1)
	go func() {
		if conn, err := listener.Accept(); err == nil {
			accepted <- struct{}{}
			_ = conn.Close()
		}
	}()
	proxy := New(slog.New(slog.NewTextHandler(io.Discard, nil)), DefaultLimits)
	if _, err := proxy.connect(context.Background(), netip.MustParseAddrPort(listener.Addr().String())); !errors.Is(err, errNotPublic) {
		t.Fatalf("connect to loopback: %v", err)
	}
	select {
	case <-accepted:
		t.Fatal("the loopback listener got a connection")
	case <-time.After(100 * time.Millisecond):
	}
}
