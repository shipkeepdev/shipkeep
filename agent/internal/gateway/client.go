// Package gateway implements the agent's outbound, installation-pinned gRPC transport.
package gateway

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"

	nodecredentials "github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/shipkeepdev/shipkeep/lib/secret"
)

const rpcTimeout = 30 * time.Second

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// Endpoint is where the gateway is. Address is host:port as the gateway certificate names it: the
// TLS name, the hostname check and the CA pin always use its host. Connect, when set, is where the
// TCP connection goes instead: a loopback address with a port, for an agent on the machine that
// hosts the control plane (ADR 0021). It changes nothing that is verified.
type Endpoint struct {
	Address string
	Connect string
}

// target returns the address to dial and the name to verify.
func (e Endpoint) target() (dial, host string, err error) {
	host, _, err = net.SplitHostPort(e.Address)
	if err != nil || host == "" {
		return "", "", errors.New("invalid gateway address")
	}
	if e.Connect == "" {
		return e.Address, host, nil
	}
	if !LoopbackConnect(e.Connect) {
		return "", "", errors.New("gateway connect address must be a loopback address with a port")
	}
	return e.Connect, host, nil
}

// LoopbackConnect reports whether connect is a canonical loopback IP literal with a non-zero port,
// such as 127.0.0.1:7443 or [::1]:7443. Names are refused: they resolve elsewhere.
func LoopbackConnect(connect string) bool {
	address, err := netip.ParseAddrPort(connect)
	return err == nil && address.String() == connect && address.Addr().IsLoopback() && address.Port() != 0
}

// Enroll proves the installation CA's identity before sending the single-use join token.
func Enroll(ctx context.Context, endpoint Endpoint, fingerprint string, dev bool, token secret.String, facts *agentv1.NodeFacts, version string) (nodecredentials.Bundle, error) {
	ctx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	if !tokenPattern.MatchString(token.Expose()) {
		return nodecredentials.Bundle{}, errors.New("invalid join token format")
	}
	ca, err := discoverCA(ctx, endpoint, fingerprint, dev)
	if err != nil {
		return nodecredentials.Bundle{}, err
	}
	key, csr, err := nodecredentials.Generate()
	if err != nil {
		return nodecredentials.Bundle{}, err
	}
	conn, err := dial(endpoint, ca, nil)
	if err != nil {
		return nodecredentials.Bundle{}, err
	}
	defer conn.Close() //nolint:errcheck // no pending RPC after the call below
	response, err := agentv1.NewAgentGatewayServiceClient(conn).Enroll(ctx, &agentv1.EnrollRequest{JoinToken: token.Expose(), CsrPem: csr, Facts: facts, AgentVersion: version})
	if err != nil {
		// Keep the gRPC code for callers (status.Code works through %w) but never the remote text.
		return nodecredentials.Bundle{}, fmt.Errorf("enrollment failed: %w", status.Error(status.Code(err), "enrollment rejected"))
	}
	b := nodecredentials.Bundle{Key: key, Certificate: response.CertPem, CA: response.CaPem, NodeID: response.NodeId, OrganizationID: response.OrganizationId, LeaseEpoch: response.LeaseEpoch, ConfirmationPublicKey: response.ConfirmationPublicKey}
	if _, err := b.Validate(nodecredentials.Fingerprint(ca)); err != nil {
		return nodecredentials.Bundle{}, err
	}
	return b, nil
}

// Open creates a client connection using the persisted, validated client identity and pinned CA.
func Open(endpoint Endpoint, b nodecredentials.Bundle) (*grpc.ClientConn, error) {
	pair, err := b.Validate("")
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode([]byte(b.CA)) // Validate has already checked this PEM.
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse pinned CA: %w", err)
	}
	return dial(endpoint, ca, []tls.Certificate{pair})
}

// Renew rotates the key and validates the new certificate before the caller persists it.
func Renew(ctx context.Context, client agentv1.AgentGatewayServiceClient, b nodecredentials.Bundle) (nodecredentials.Bundle, error) {
	ctx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	key, csr, err := nodecredentials.Generate()
	if err != nil {
		return nodecredentials.Bundle{}, err
	}
	response, err := client.RenewCertificate(ctx, &agentv1.RenewCertificateRequest{CsrPem: csr})
	if err != nil {
		return nodecredentials.Bundle{}, fmt.Errorf("certificate renewal: %w", status.Error(status.Code(err), "renewal failed"))
	}
	b.Key, b.Certificate = key, response.CertPem
	if _, err := b.Validate(""); err != nil {
		return nodecredentials.Bundle{}, err
	}
	return b, nil
}

func dial(endpoint Endpoint, ca *x509.Certificate, certificates []tls.Certificate) (*grpc.ClientConn, error) {
	address, _, err := endpoint.target()
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	dialer := &net.Dialer{}
	// The target keeps the public address: gRPC uses it as the authority and takes the TLS name
	// from it (a ServerName in the TLS settings would replace the authority and drop its port).
	// Only the TCP connection goes to address.
	conn, err := grpc.NewClient("passthrough:///"+endpoint.Address,
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return dialer.DialContext(ctx, "tcp", address) }),
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{RootCAs: roots, Certificates: certificates, MinVersion: tls.VersionTLS13})), grpc.WithDisableRetry(), grpc.WithKeepaliveParams(keepalive.ClientParameters{Time: 20 * time.Second, Timeout: 10 * time.Second}), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(nodecredentials.MaxBytes), grpc.MaxCallSendMsgSize(nodecredentials.MaxBytes)))
	if err != nil {
		return nil, fmt.Errorf("create gateway connection: %w", err)
	}
	return conn, nil
}

// discoverCA sends no application data. Its custom verifier checks both the pinned root and
// the normal server chain/hostname/validity before any enrollment RPC is possible.
func discoverCA(ctx context.Context, endpoint Endpoint, fingerprint string, dev bool) (*x509.Certificate, error) {
	if fingerprint == "" && !dev {
		return nil, errors.New("installation CA fingerprint is required")
	}
	address, host, err := endpoint.target()
	if err != nil {
		return nil, err
	}
	var trusted *x509.Certificate
	config := &tls.Config{MinVersion: tls.VersionTLS13, ServerName: host, NextProtos: []string{"h2"},
		InsecureSkipVerify: true, // #nosec G402 -- VerifyConnection below replaces system roots with the operator's pinned CA and verifies hostname, chain and validity.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) < 2 {
				return errors.New("gateway must send its installation CA chain")
			}
			ca := state.PeerCertificates[len(state.PeerCertificates)-1]
			if !ca.IsCA || ca.CheckSignatureFrom(ca) != nil || (fingerprint != "" && nodecredentials.Fingerprint(ca) != fingerprint) {
				return errors.New("installation CA fingerprint mismatch")
			}
			roots, intermediates := x509.NewCertPool(), x509.NewCertPool()
			roots.AddCert(ca)
			for _, cert := range state.PeerCertificates[1 : len(state.PeerCertificates)-1] {
				intermediates.AddCert(cert)
			}
			if _, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, DNSName: host, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
				return errors.New("invalid gateway certificate")
			}
			trusted = ca
			return nil
		},
	}
	dialer := tls.Dialer{Config: config}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, errors.New("gateway TLS verification failed")
	}
	if err := conn.Close(); err != nil {
		return nil, fmt.Errorf("close enrollment trust probe: %w", err)
	}
	if trusted == nil {
		return nil, errors.New("gateway did not present a verified CA")
	}
	return trusted, nil
}
