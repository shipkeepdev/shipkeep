package certwatch

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"slices"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

type hosts struct {
	names []string
	err   error
}

func (h *hosts) TLSHosts(context.Context) ([]string, error) { return h.names, h.err }

func certificate(t *testing.T, names []string, issuer string, notAfter time.Time) *x509.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: issuer}, // self-signed: the issuer is the subject
		DNSNames: names, NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestReadsEachHostOnceUntilItIsStale(t *testing.T) {
	expiry := time.Date(2027, 2, 1, 0, 0, 0, 0, time.UTC)
	reads := map[string]int{}
	w := &Watcher{Hosts: &hosts{names: []string{"b.example.com", "a.example.com"}}, Logger: quiet(), Refresh: 10 * time.Minute,
		Read: func(_ context.Context, _ string, host string) (*x509.Certificate, error) {
			reads[host]++
			return certificate(t, []string{host}, "Example CA", expiry), nil
		}}
	now := time.Now()
	w.pass(context.Background(), now)
	w.pass(context.Background(), now.Add(time.Minute))
	if reads["a.example.com"] != 1 || reads["b.example.com"] != 1 {
		t.Fatalf("read again before going stale: %v", reads)
	}
	w.pass(context.Background(), now.Add(11*time.Minute))
	if reads["a.example.com"] != 2 {
		t.Fatalf("not read again once stale: %v", reads)
	}
	got := w.Snapshot(time.Now())
	if len(got) != 2 || got[0].GetHostname() != "a.example.com" || !got[0].GetNotAfter().AsTime().Equal(expiry) || got[0].GetIssuer() != "Example CA" {
		t.Fatalf("snapshot = %v", got)
	}
}

// A certificate for another name is Caddy's fallback, not the host's: nothing is reported.
func TestReportsNothingForAHostWithoutItsCertificate(t *testing.T) {
	w := &Watcher{Hosts: &hosts{names: []string{"app.example.com", "down.example.com"}}, Logger: quiet(),
		Read: func(_ context.Context, _ string, host string) (*x509.Certificate, error) {
			if host == "down.example.com" {
				return nil, errors.New("connection refused")
			}
			return certificate(t, []string{"other.example.com"}, "CA", time.Now().Add(time.Hour)), nil
		}}
	w.pass(context.Background(), time.Now())
	if got := w.Snapshot(time.Now()); len(got) != 0 {
		t.Fatalf("reported %v", got)
	}
}

func TestForgetsHostsNoLongerRoutedAndKeepsReadingsWhenCaddyIsDown(t *testing.T) {
	list := &hosts{names: []string{"a.example.com", "b.example.com"}}
	w := &Watcher{Hosts: list, Logger: quiet(), Read: func(_ context.Context, _ string, host string) (*x509.Certificate, error) {
		return certificate(t, []string{host}, "CA", time.Now().Add(time.Hour)), nil
	}}
	w.pass(context.Background(), time.Now())
	list.err = errors.New("caddy starting")
	w.pass(context.Background(), time.Now())
	if len(w.Snapshot(time.Now())) != 2 {
		t.Fatal("readings dropped while Caddy did not answer")
	}
	list.names, list.err = []string{"b.example.com"}, nil
	w.pass(context.Background(), time.Now())
	if got := w.Snapshot(time.Now()); len(got) != 1 || got[0].GetHostname() != "b.example.com" {
		t.Fatalf("snapshot = %v", got)
	}
}

func TestBoundsHostsAndIssuer(t *testing.T) {
	names := make([]string, 0, MaxHosts+20)
	for i := range MaxHosts + 20 {
		names = append(names, "h"+strings.Repeat("x", i%5)+string(rune('a'+i%26))+".example.com")
	}
	long := strings.Repeat("é", 100) + "\x00\nCA"
	w := &Watcher{Hosts: &hosts{names: names}, Logger: quiet(), Read: func(_ context.Context, _ string, host string) (*x509.Certificate, error) {
		return certificate(t, []string{host}, long, time.Now().Add(time.Hour)), nil
	}}
	w.pass(context.Background(), time.Now())
	got := w.Snapshot(time.Now())
	if len(got) > MaxHosts {
		t.Fatalf("%d readings", len(got))
	}
	for _, status := range got {
		if len(status.GetIssuer()) > maxIssuer || strings.ContainsAny(status.GetIssuer(), "\x00\n") {
			t.Fatalf("issuer %q", status.GetIssuer())
		}
	}
}

// The real handshake reads the leaf a TLS server presents for the SNI name, without verifying it.
func TestHandshakeReadsTheServedCertificate(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "app.example.com"}, DNSNames: []string{"app.example.com"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Date(2027, 3, 4, 5, 6, 7, 0, time.UTC)}
	der, _ := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close() //nolint:errcheck // test listener
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			if session, ok := conn.(*tls.Conn); ok {
				_ = session.HandshakeContext(context.Background())
			}
			_ = conn.Close()
		}
	}()
	leaf, err := handshake(context.Background(), listener.Addr().String(), "app.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !leaf.NotAfter.Equal(template.NotAfter) || leaf.VerifyHostname("app.example.com") != nil {
		t.Fatalf("leaf %v", leaf.NotAfter)
	}
	if _, err := handshake(context.Background(), "127.0.0.1:1", "app.example.com"); err == nil {
		t.Fatal("a closed port gave a certificate")
	}
}

// A handshake that fails keeps the last reading: the listener may be restarting. A certificate
// for another name removes it: Caddy no longer serves one for this host.
func TestKeepsTheReadingWhenTheHandshakeFails(t *testing.T) {
	answer := "valid"
	w := &Watcher{Hosts: &hosts{names: []string{"app.example.com"}}, Logger: quiet(), Refresh: time.Minute,
		Read: func(_ context.Context, _ string, host string) (*x509.Certificate, error) {
			switch answer {
			case "down":
				return nil, errors.New("connection refused")
			case "other":
				return certificate(t, []string{"other.example.com"}, "CA", time.Now().Add(time.Hour)), nil
			}
			return certificate(t, []string{host}, "CA", time.Now().Add(time.Hour)), nil
		}}
	now := time.Now()
	w.pass(context.Background(), now)
	answer = "down"
	w.pass(context.Background(), now.Add(time.Minute))
	if got := w.Snapshot(time.Now()); len(got) != 1 {
		t.Fatalf("a failed handshake dropped the reading: %v", got)
	}
	answer = "other"
	w.pass(context.Background(), now.Add(2*time.Minute))
	if got := w.Snapshot(time.Now()); len(got) != 0 {
		t.Fatalf("a certificate for another name was kept: %v", got)
	}
}

// Every outcome waits Refresh before the next handshake, not only an accepted reading.
func TestRetriesAFailedHostOnlyAfterRefresh(t *testing.T) {
	reads := 0
	w := &Watcher{Hosts: &hosts{names: []string{"app.example.com"}}, Logger: quiet(), Refresh: 10 * time.Minute,
		Read: func(context.Context, string, string) (*x509.Certificate, error) {
			reads++
			return certificate(t, []string{"other.example.com"}, "CA", time.Now().Add(time.Hour)), nil
		}}
	now := time.Now()
	for minute := 0; minute < 10; minute++ {
		w.pass(context.Background(), now.Add(time.Duration(minute)*time.Minute))
	}
	if reads != 1 {
		t.Fatalf("%d handshakes in ten minutes for a host that presents another name", reads)
	}
	w.pass(context.Background(), now.Add(10*time.Minute))
	if reads != 2 {
		t.Fatalf("%d handshakes after Refresh", reads)
	}
}

// While Caddy's routes stay unreadable, a reading is kept for a while, then no longer reported:
// the control plane would otherwise refresh it forever.
func TestStopsReportingAReadingNeverRefreshed(t *testing.T) {
	list := &hosts{names: []string{"app.example.com"}}
	w := &Watcher{Hosts: list, Logger: quiet(), Refresh: 10 * time.Minute, Read: func(_ context.Context, _ string, host string) (*x509.Certificate, error) {
		return certificate(t, []string{host}, "CA", time.Now().Add(time.Hour)), nil
	}}
	read := time.Now()
	w.pass(context.Background(), read)
	list.err = errors.New("admin API down")
	for minute := 1; minute <= 40; minute++ {
		w.pass(context.Background(), read.Add(time.Duration(minute)*time.Minute))
	}
	if got := w.Snapshot(read.Add(29 * time.Minute)); len(got) != 1 {
		t.Fatalf("a recent reading was dropped: %v", got)
	}
	if got := w.Snapshot(read.Add(30 * time.Minute)); len(got) != 0 {
		t.Fatalf("a reading unrefreshed for three refresh delays was still reported: %v", got)
	}
}

// A C1 control in one issuer is removed there, and the other certificates are untouched: the
// control plane refuses a whole report for one such character.
func TestRemovesC1ControlsFromTheIssuer(t *testing.T) {
	w := &Watcher{Hosts: &hosts{names: []string{"a.example.com", "b.example.com"}}, Logger: quiet(), Read: func(_ context.Context, _ string, host string) (*x509.Certificate, error) {
		name := "R11"
		if host == "a.example.com" {
			name = "R\u008510\u009b"
		}
		return certificate(t, []string{host}, name, time.Now().Add(time.Hour)), nil
	}}
	w.pass(context.Background(), time.Now())
	got := w.Snapshot(time.Now())
	if len(got) != 2 || got[0].GetIssuer() != "R10" || got[1].GetIssuer() != "R11" {
		t.Fatalf("snapshot = %v", got)
	}
}

// A full workload inventory keeps its place in the state report: the certificates take only the
// room it leaves, those that expire first before the others.
func TestWithinKeepsTheInventoryAndTheSoonestExpiries(t *testing.T) {
	const limit = 60 * 1024 // gateway.MaxReportBytes
	report := &agentv1.StateReport{}
	for i := range 256 {
		report.Containers = append(report.Containers, &agentv1.ContainerStatus{
			ContainerId: strings.Repeat("f", 64),
			Name:        "sk-" + strings.Repeat("a", 56) + string(rune('a'+i%26)),
			State:       agentv1.ContainerStatus_STATE_RUNNING,
			Labels:      map[string]string{"sk.managed": "true"},
			StopReason:  "disk_limit",
		})
	}
	base := time.Now()
	statuses := make([]*agentv1.CertificateStatus, 0, MaxHosts)
	for i := range MaxHosts {
		statuses = append(statuses, &agentv1.CertificateStatus{
			Hostname: fmt.Sprintf("%02d.%s.example.com", i, strings.Repeat("h", 200)),
			NotAfter: timestamppb.New(base.Add(time.Duration(MaxHosts-i) * time.Hour)),
			Issuer:   strings.Repeat("i", maxIssuer),
		})
	}
	kept := Within(statuses, limit-64-proto.Size(report))
	report.Certificates = kept
	if size := proto.Size(report); size >= limit-64 {
		t.Fatalf("report of %d bytes", size)
	}
	if len(report.GetContainers()) != 256 {
		t.Fatal("the inventory was cut")
	}
	if len(kept) == 0 || len(kept) == MaxHosts {
		t.Fatalf("kept %d certificates: the budget was not applied", len(kept))
	}
	// The latest-indexed hosts expire first: they are the ones kept.
	for _, status := range kept {
		if !status.GetNotAfter().AsTime().Before(base.Add(time.Duration(len(kept)+1) * time.Hour)) {
			t.Fatalf("kept %s, which expires later than one left out", status.GetHostname())
		}
	}
	if !slices.IsSortedFunc(kept, func(a, b *agentv1.CertificateStatus) int { return strings.Compare(a.GetHostname(), b.GetHostname()) }) {
		t.Fatal("not sorted by host name")
	}
	if got := Within(statuses, -1); len(got) != 0 {
		t.Fatalf("a full report got %d certificates", len(got))
	}
}
