// Package certwatch reads the certificates the node's Caddy serves for its HTTPS routes (PLAN
// M3.6b2), so that the control plane can show when one expires. It connects to Caddy on loopback
// with each host name as SNI and reads the certificate of the handshake. It never sends a request.
package certwatch

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"log/slog"
	"net"
	"slices"
	"sync"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// Limits of what the watcher holds and reports, so that a node with many routes keeps its state
// report well under the 60 KiB the agent sends (about 340 bytes per host at most).
const (
	MaxHosts     = 64
	maxIssuer    = 64
	dialTimeout  = 3 * time.Second
	defaultAfter = 10 * time.Minute
)

// Hosts lists the host names of the node's HTTPS routes.
type Hosts interface {
	TLSHosts(ctx context.Context) ([]string, error)
}

// Watcher keeps the last certificate seen for each host.
type Watcher struct {
	Hosts  Hosts
	Logger *slog.Logger
	// Address is Caddy's HTTPS listener, 127.0.0.1:443 on a node.
	Address string
	// Interval between two passes; Refresh is how old a reading may get before it is read again.
	Interval time.Duration
	Refresh  time.Duration
	// Read replaces the handshake in tests.
	Read func(ctx context.Context, address, host string) (*x509.Certificate, error)

	mu       sync.Mutex
	readings map[string]reading
	// attempts holds when each host was last read, whatever the outcome, so that a host whose
	// handshake fails or presents another name's certificate waits Refresh like any other.
	attempts map[string]time.Time
}

type reading struct {
	notAfter time.Time
	issuer   string
	// at is when the certificate was last read: a reading never refreshed for staleAfter, because
	// Caddy's routes or listener stay unreadable, is no longer reported.
	at time.Time
}

// staleAfter is how many refresh delays a reading may go without a successful read.
const staleAfter = 3

// Run reads the certificates until ctx ends: at once, then every Interval.
func (w *Watcher) Run(ctx context.Context) {
	ticker := time.NewTicker(w.Interval)
	defer ticker.Stop()
	for {
		w.pass(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (w *Watcher) pass(ctx context.Context, now time.Time) {
	hosts, err := w.Hosts.TLSHosts(ctx)
	if err != nil {
		// Caddy may be starting: the last readings stay until the next pass.
		w.Logger.Debug("certificate hosts not read", "error", err)
		return
	}
	if len(hosts) > MaxHosts {
		hosts = hosts[:MaxHosts]
	}
	refresh := w.Refresh
	if refresh <= 0 {
		refresh = defaultAfter
	}
	read := w.Read
	if read == nil {
		read = handshake
	}
	w.mu.Lock()
	if w.readings == nil {
		w.readings = map[string]reading{}
		w.attempts = map[string]time.Time{}
	}
	// A name no longer routed is forgotten, its reading and its last attempt.
	for host := range w.attempts {
		if !slices.Contains(hosts, host) {
			delete(w.attempts, host)
			delete(w.readings, host)
		}
	}
	due := []string{}
	for _, host := range hosts {
		if last, ok := w.attempts[host]; !ok || now.Sub(last) >= refresh {
			due = append(due, host)
			w.attempts[host] = now
		}
	}
	w.mu.Unlock()
	for _, host := range due {
		certificate, err := read(ctx, w.Address, host)
		w.mu.Lock()
		switch {
		case err != nil:
			// Caddy's listener did not answer: the last reading stays until it does.
			w.Logger.Debug("certificate not read", "host", host, "error", err)
		case certificate == nil || certificate.VerifyHostname(host) != nil:
			// No certificate for this name yet (or Caddy's fallback): report nothing for it.
			delete(w.readings, host)
		default:
			w.readings[host] = reading{notAfter: certificate.NotAfter, issuer: issuer(certificate), at: now}
		}
		w.mu.Unlock()
	}
}

// Snapshot returns the readings, sorted by host name, without those that went unrefreshed for
// staleAfter refresh delays at now: the control plane would otherwise keep them fresh forever.
func (w *Watcher) Snapshot(now time.Time) []*agentv1.CertificateStatus {
	refresh := w.Refresh
	if refresh <= 0 {
		refresh = defaultAfter
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	statuses := make([]*agentv1.CertificateStatus, 0, len(w.readings))
	for host, last := range w.readings {
		if now.Sub(last.at) >= staleAfter*refresh {
			continue
		}
		statuses = append(statuses, &agentv1.CertificateStatus{Hostname: host, NotAfter: timestamppb.New(last.notAfter), Issuer: last.issuer})
	}
	slices.SortFunc(statuses, func(a, b *agentv1.CertificateStatus) int {
		switch {
		case a.GetHostname() < b.GetHostname():
			return -1
		case a.GetHostname() > b.GetHostname():
			return 1
		}
		return 0
	})
	return statuses
}

func issuer(certificate *x509.Certificate) string {
	name := certificate.Issuer.CommonName
	if name == "" && len(certificate.Issuer.Organization) > 0 {
		name = certificate.Issuer.Organization[0]
	}
	cut := []rune{}
	for _, r := range name {
		// C0 and C1 controls: the control plane refuses a report that holds one.
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			continue
		}
		cut = append(cut, r)
		if len(string(cut)) > maxIssuer {
			cut = cut[:len(cut)-1]
			break
		}
	}
	return string(cut)
}

// handshake connects to Caddy with host as SNI and returns the leaf certificate it presents. The
// chain is not verified here: the point is to read what Caddy serves, valid or not.
func handshake(ctx context.Context, address, host string) (*x509.Certificate, error) {
	dialer := &tls.Dialer{
		NetDialer: &net.Dialer{Timeout: dialTimeout},
		Config:    &tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}, //nolint:gosec // reads the certificate served, which is then checked against the name only
	}
	ctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err //nolint:wrapcheck // the caller only checks for a failure
	}
	defer conn.Close() //nolint:errcheck // read-only connection
	session, ok := conn.(*tls.Conn)
	if !ok {
		return nil, net.ErrClosed
	}
	certificates := session.ConnectionState().PeerCertificates
	if len(certificates) == 0 {
		return nil, net.ErrClosed
	}
	return certificates[0], nil
}
