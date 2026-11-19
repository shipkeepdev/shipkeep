package egress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Address is where the proxy listens, and what the Docker daemon is pointed at (ADR 0023).
const Address = "127.0.0.1:7480"

// Limits bound what the proxy holds.
type Limits struct {
	// Tunnels open at once; one more is refused.
	Tunnels int
	// Time to resolve the name and connect to it.
	Connect time.Duration
	// Longest life of a tunnel, enough to pull a large layer.
	Lifetime time.Duration
	// Time to read a request, body included, and to write a refusal. A tunnel replaces these
	// deadlines with its lifetime once it is established.
	Request time.Duration
}

// DefaultLimits are those of ADR 0023.
var DefaultLimits = Limits{Tunnels: 64, Connect: 10 * time.Second, Lifetime: time.Hour, Request: 10 * time.Second}

// Resolver returns the addresses of a host name.
type Resolver func(ctx context.Context, host string) ([]netip.Addr, error)

// Proxy tunnels CONNECT requests to public addresses and refuses everything else.
type Proxy struct {
	Logger  *slog.Logger
	Limits  Limits
	Resolve Resolver
	// dial replaces the guarded dialer in tests; the public check still runs before it.
	dial    func(ctx context.Context, address netip.AddrPort) (net.Conn, error)
	tunnels chan struct{}

	// Established tunnels: Shutdown does not track hijacked connections, so Serve closes and
	// joins them itself.
	mu      sync.Mutex
	closing bool
	live    map[net.Conn]struct{}
	running sync.WaitGroup
}

// New returns a proxy that resolves names with the system resolver.
func New(logger *slog.Logger, limits Limits) *Proxy {
	return &Proxy{Logger: logger, Limits: limits, Resolve: func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}}
}

// errNotPublic is the refusal of a destination outside the policy.
var errNotPublic = errors.New("destination is not a public address")

// guard is the dialer's last check: it runs on the address the socket is about to connect to,
// so no earlier answer, cache or second resolution can change what is reached.
func guard(_, address string, _ syscall.RawConn) error {
	parsed, err := netip.ParseAddrPort(address)
	if err != nil || !Public(parsed.Addr()) {
		return errNotPublic
	}
	return nil
}

func (p *Proxy) connect(ctx context.Context, address netip.AddrPort) (net.Conn, error) {
	if p.dial != nil {
		if !Public(address.Addr()) {
			return nil, errNotPublic
		}
		return p.dial(ctx, address)
	}
	dialer := net.Dialer{Control: guard}
	conn, err := dialer.DialContext(ctx, "tcp", address.String())
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	return conn, nil
}

// Serve accepts proxy requests on listener until ctx ends or the listener fails. It returns once
// every request and every tunnel has ended.
func (p *Proxy) Serve(ctx context.Context, listener net.Listener) error {
	p.tunnels = make(chan struct{}, p.Limits.Tunnels)
	p.live = map[net.Conn]struct{}{}
	server := &http.Server{
		Handler:           p,
		ReadHeaderTimeout: p.Limits.Request,
		ReadTimeout:       p.Limits.Request,
		WriteTimeout:      p.Limits.Request + p.Limits.Connect,
		IdleTimeout:       p.Limits.Request,
		MaxHeaderBytes:    8 << 10,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		ErrorLog:          slog.NewLogLogger(p.Logger.Handler(), slog.LevelWarn),
	}
	served := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-ctx.Done():
		case <-served:
		}
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		p.closeTunnels()
	}()
	err := server.Serve(listener)
	close(served)
	<-done
	p.running.Wait()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("serve egress proxy: %w", err)
}

// track registers an established tunnel's connections; false once the proxy is closing, in which
// case they are closed at once.
func (p *Proxy) track(conns ...net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closing {
		for _, conn := range conns {
			_ = conn.Close()
		}
		return false
	}
	for _, conn := range conns {
		p.live[conn] = struct{}{}
	}
	return true
}

func (p *Proxy) untrack(conns ...net.Conn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, conn := range conns {
		delete(p.live, conn)
	}
}

// closeTunnels ends every established tunnel; their handlers then return.
func (p *Proxy) closeTunnels() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closing = true
	for conn := range p.live {
		_ = conn.Close()
	}
}

// ServeHTTP handles one proxy request. Only CONNECT is served: the daemon's registry traffic
// stays HTTPS end to end, and a request in plain HTTP (a redirect or a token service on http://)
// is refused without being forwarded.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Serve waits for every handler, the hijacked ones included, before it returns.
	p.running.Add(1)
	defer p.running.Done()
	if r.Method != http.MethodConnect {
		p.Logger.Warn("egress refused", "reason", "not_connect", "method", r.Method)
		http.Error(w, "only HTTPS tunnels are allowed", http.StatusForbidden)
		return
	}
	host, port, ok := target(r.Host)
	if !ok {
		p.Logger.Warn("egress refused", "reason", "invalid_target")
		http.Error(w, "invalid tunnel target", http.StatusBadRequest)
		return
	}
	select {
	case p.tunnels <- struct{}{}:
		defer func() { <-p.tunnels }()
	default:
		p.Logger.Warn("egress refused", "reason", "busy", "host", host, "port", port)
		http.Error(w, "too many tunnels", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), p.Limits.Connect)
	upstream, reason := p.open(ctx, host, port)
	cancel()
	if upstream == nil {
		p.Logger.Warn("egress refused", "reason", reason, "host", host, "port", port)
		status := http.StatusBadGateway
		if reason == "not_public" {
			status = http.StatusForbidden
		}
		http.Error(w, "tunnel refused", status)
		return
	}
	defer upstream.Close() //nolint:errcheck // closing a finished tunnel
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "tunnel unavailable", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close() //nolint:errcheck // closing a finished tunnel
	if !p.track(client, upstream) {
		return
	}
	defer p.untrack(client, upstream)
	if _, err := client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n")); err != nil {
		return
	}
	deadline := time.Now().Add(p.Limits.Lifetime)
	_ = client.SetDeadline(deadline)
	_ = upstream.SetDeadline(deadline)
	p.Logger.Info("egress tunnel", "host", host, "port", port)
	pipe(client, buffered, upstream)
}

// open resolves host and connects to the first of its addresses that answers. Every address
// must be public: a name with one private answer is refused, as the control plane does.
func (p *Proxy) open(ctx context.Context, host string, port uint16) (net.Conn, string) {
	var addresses []netip.Addr
	if literal, err := netip.ParseAddr(host); err == nil {
		addresses = []netip.Addr{literal}
	} else {
		found, err := p.Resolve(ctx, host)
		if err != nil || len(found) == 0 {
			return nil, "unresolved"
		}
		addresses = found
	}
	for _, address := range addresses {
		if !Public(address) {
			return nil, "not_public"
		}
	}
	deadline, bounded := ctx.Deadline()
	for i, address := range addresses {
		// Each address gets its share of the time left, so one that drops connection attempts
		// cannot spend the time of those after it.
		attempt, cancel := ctx, context.CancelFunc(func() {})
		if bounded {
			attempt, cancel = context.WithTimeout(ctx, time.Until(deadline)/time.Duration(len(addresses)-i))
		}
		conn, err := p.connect(attempt, netip.AddrPortFrom(address.Unmap(), port))
		cancel()
		if errors.Is(err, errNotPublic) {
			return nil, "not_public"
		}
		if err == nil {
			return conn, ""
		}
	}
	return nil, "unreachable"
}

// target splits a CONNECT authority into a host and a port. The host is a DNS name or an IP
// literal, never empty, and the port is explicit.
func target(authority string) (string, uint16, bool) {
	host, portText, err := net.SplitHostPort(authority)
	if err != nil || host == "" || len(host) > 253 {
		return "", 0, false
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 || portText != strconv.FormatUint(port, 10) {
		return "", 0, false
	}
	if _, err := netip.ParseAddr(host); err != nil && !hostname(host) {
		return "", 0, false
	}
	return host, uint16(port), true
}

// hostname accepts letters, digits, hyphens and dots, in labels of 1 to 63 characters.
func hostname(name string) bool {
	label := 0
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c == '.':
			if label == 0 {
				return false
			}
			label = 0
		case c == '-' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
			label++
			if label > 63 {
				return false
			}
		default:
			return false
		}
	}
	return label > 0
}

// pipe copies both ways until either side ends, then closes both.
func pipe(client net.Conn, buffered io.Reader, upstream net.Conn) {
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			_ = client.Close()
			_ = upstream.Close()
		})
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(upstream, buffered)
		closeBoth()
	}()
	_, _ = io.Copy(client, upstream)
	closeBoth()
	<-done
}
