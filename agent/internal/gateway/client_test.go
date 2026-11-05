package gateway

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"

	nodecredentials "github.com/samuelmbabhazi/shipkeep/agent/internal/credentials"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/samuelmbabhazi/shipkeep/lib/secret"
)

const testNode = "0192f0c0-0000-7000-8000-000000000002"
const testOrg = "0192f0c0-0000-7000-8000-000000000001"

var testToken = secret.NewString(strings.Repeat("a", 43))

type testGateway struct {
	agentv1.UnimplementedAgentGatewayServiceServer
	ca         *x509.Certificate
	key        ed25519.PrivateKey
	calls      atomic.Int32
	connects   atomic.Int32
	heartbeats atomic.Int32
	disconnect atomic.Bool
	rejected   atomic.Bool
	renewSoon  atomic.Bool
}

func (g *testGateway) certificate(csrPEM string) (string, error) {
	block, _ := pem.Decode([]byte(csrPEM))
	if block == nil {
		return "", status.Error(codes.InvalidArgument, "bad CSR")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		return "", status.Error(codes.InvalidArgument, "bad CSR")
	}
	identity, _ := url.Parse("spiffe://shipkeep/" + testOrg + "/node/" + testNode)
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return "", err
	}
	leaf := &x509.Certificate{SerialNumber: serial, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), URIs: []*url.URL{identity}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	if g.renewSoon.Swap(false) {
		leaf.NotBefore = time.Now().Add(-2 * time.Hour)
		leaf.NotAfter = time.Now().Add(10 * time.Minute)
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, g.ca, csr.PublicKey, g.key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), nil
}

func (g *testGateway) Enroll(_ context.Context, request *agentv1.EnrollRequest) (*agentv1.EnrollResponse, error) {
	g.calls.Add(1)
	if request.JoinToken != testToken.Expose() {
		return nil, status.Error(codes.InvalidArgument, request.JoinToken)
	}
	cert, err := g.certificate(request.CsrPem)
	if err != nil {
		return nil, err
	}
	return &agentv1.EnrollResponse{CertPem: cert, CaPem: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: g.ca.Raw})), NodeId: testNode, OrganizationId: testOrg, LeaseEpoch: 1}, nil
}

func (g *testGateway) RenewCertificate(ctx context.Context, request *agentv1.RenewCertificateRequest) (*agentv1.RenewCertificateResponse, error) {
	remote, ok := peer.FromContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "missing peer")
	}
	auth, ok := remote.AuthInfo.(credentials.TLSInfo)
	if !ok || len(auth.State.VerifiedChains) == 0 {
		return nil, status.Error(codes.Unauthenticated, "missing client certificate")
	}
	cert, err := g.certificate(request.CsrPem)
	return &agentv1.RenewCertificateResponse{CertPem: cert}, err
}

func startGateway(t *testing.T, validHostname bool, configure ...func(*x509.Certificate)) (string, *testGateway) {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test installation"}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	caDER, err := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	serverPub, serverKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), NotBefore: template.NotBefore, NotAfter: template.NotAfter, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"wrong.example.com"}}
	if validHostname {
		leaf.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
	}
	for _, change := range configure {
		change(leaf)
	}
	certDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, serverPub, key)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{{Certificate: [][]byte{certDER, caDER}, PrivateKey: serverKey}}, ClientAuth: tls.VerifyClientCertIfGiven, ClientCAs: pool})))
	gateway := &testGateway{ca: ca, key: key}
	agentv1.RegisterAgentGatewayServiceServer(server, gateway)
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { defer close(done); _ = server.Serve(listener) }()
	t.Cleanup(func() { server.Stop(); <-done })
	return listener.Addr().String(), gateway
}

func TestEnrollmentAndKeyRotationOverRealTLS(t *testing.T) {
	address, server := startGateway(t, true)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	bundle, err := Enroll(ctx, address, nodecredentials.Fingerprint(server.ca), false, testToken, &agentv1.NodeFacts{Hostname: "test-node"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	if bundle.NodeID != testNode || server.calls.Load() != 1 {
		t.Fatal("enrollment identity missing")
	}
	conn, err := Open(address, bundle)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close() //nolint:errcheck // test connection
	renewed, err := Renew(ctx, agentv1.NewAgentGatewayServiceClient(conn), bundle)
	if err != nil {
		t.Fatal(err)
	}
	if renewed.Key.Equal(bundle.Key) || renewed.Certificate == bundle.Certificate {
		t.Fatal("renewal did not rotate key/certificate")
	}
	if _, err := renewed.Validate(nodecredentials.Fingerprint(server.ca)); err != nil {
		t.Fatal(err)
	}
}

func TestUntrustedGatewayNeverReceivesToken(t *testing.T) {
	address, server := startGateway(t, true)
	wrongAddress, wrongHost := startGateway(t, false)
	for _, test := range []struct{ address, fingerprint string }{
		{address, "sha256:" + strings.Repeat("0", 64)},
		{address, ""},
		{address, nodecredentials.Fingerprint(wrongHost.ca)},
		{wrongAddress, nodecredentials.Fingerprint(wrongHost.ca)},
	} {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		_, err := Enroll(ctx, test.address, test.fingerprint, false, testToken, nil, "test")
		cancel()
		if err == nil {
			t.Fatal("accepted untrusted gateway")
		}
		if strings.Contains(err.Error(), testToken.Expose()) {
			t.Fatal("token leaked in error")
		}
	}
	if server.calls.Load() != 0 || wrongHost.calls.Load() != 0 {
		t.Fatal("token sent before CA and hostname verification")
	}
}

func TestEnrollmentErrorsNeverEchoTokens(t *testing.T) {
	address, server := startGateway(t, true)
	rejected := secret.NewString(strings.Repeat("b", 43))
	_, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, rejected, nil, "test")
	if err == nil || strings.Contains(err.Error(), rejected.Expose()) {
		t.Fatal("RPC error disclosed token")
	}
}

func TestExpiredGatewayAndOversizedMessagesAreRejected(t *testing.T) {
	address, server := startGateway(t, true, func(cert *x509.Certificate) { cert.NotAfter = time.Now().Add(-time.Minute) })
	if _, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test"); err == nil {
		t.Fatal("accepted expired server certificate")
	}
	if server.calls.Load() != 0 {
		t.Fatal("sent token to expired server")
	}
	address, server = startGateway(t, true)
	if _, err := Enroll(t.Context(), address, nodecredentials.Fingerprint(server.ca), false, testToken, nil, strings.Repeat("x", nodecredentials.MaxBytes)); err == nil {
		t.Fatal("accepted oversized request")
	}
	if server.calls.Load() != 0 {
		t.Fatal("oversized RPC reached server")
	}
}
