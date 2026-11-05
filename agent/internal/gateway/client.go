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
	"regexp"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"

	nodecredentials "github.com/samuelmbabhazi/shipkeep/agent/internal/credentials"
	agentv1 "github.com/samuelmbabhazi/shipkeep/lib/gen/shipkeep/agent/v1"
	"github.com/samuelmbabhazi/shipkeep/lib/secret"
)

const rpcTimeout = 30 * time.Second

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// Enroll proves the installation CA's identity before sending the single-use join token.
func Enroll(ctx context.Context, address, fingerprint string, dev bool, token secret.String, facts *agentv1.NodeFacts, version string) (nodecredentials.Bundle, error) {
	ctx, cancel := context.WithTimeout(ctx, rpcTimeout)
	defer cancel()
	if !tokenPattern.MatchString(token.Expose()) {
		return nodecredentials.Bundle{}, errors.New("invalid join token format")
	}
	ca, err := discoverCA(ctx, address, fingerprint, dev)
	if err != nil {
		return nodecredentials.Bundle{}, err
	}
	key, csr, err := nodecredentials.Generate()
	if err != nil {
		return nodecredentials.Bundle{}, err
	}
	conn, err := dial(address, ca, nil)
	if err != nil {
		return nodecredentials.Bundle{}, err
	}
	defer conn.Close() //nolint:errcheck // no pending RPC after the call below
	response, err := agentv1.NewAgentGatewayServiceClient(conn).Enroll(ctx, &agentv1.EnrollRequest{JoinToken: token.Expose(), CsrPem: csr, Facts: facts, AgentVersion: version})
	if err != nil {
		return nodecredentials.Bundle{}, fmt.Errorf("enrollment failed (%s)", status.Code(err))
	}
	b := nodecredentials.Bundle{Key: key, Certificate: response.CertPem, CA: response.CaPem, NodeID: response.NodeId, OrganizationID: response.OrganizationId, LeaseEpoch: response.LeaseEpoch, ConfirmationPublicKey: response.ConfirmationPublicKey}
	if _, err := b.Validate(nodecredentials.Fingerprint(ca)); err != nil {
		return nodecredentials.Bundle{}, err
	}
	return b, nil
}

// Open creates a client connection using the persisted, validated client identity and pinned CA.
func Open(address string, b nodecredentials.Bundle) (*grpc.ClientConn, error) {
	pair, err := b.Validate("")
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode([]byte(b.CA)) // Validate has already checked this PEM.
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse pinned CA: %w", err)
	}
	return dial(address, ca, []tls.Certificate{pair})
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
		return nodecredentials.Bundle{}, fmt.Errorf("certificate renewal failed (%s)", status.Code(err))
	}
	b.Key, b.Certificate = key, response.CertPem
	if _, err := b.Validate(""); err != nil {
		return nodecredentials.Bundle{}, err
	}
	return b, nil
}

func dial(address string, ca *x509.Certificate, certificates []tls.Certificate) (*grpc.ClientConn, error) {
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	conn, err := grpc.NewClient("passthrough:///"+address, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{RootCAs: roots, Certificates: certificates, MinVersion: tls.VersionTLS13})), grpc.WithDisableRetry(), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(nodecredentials.MaxBytes), grpc.MaxCallSendMsgSize(nodecredentials.MaxBytes)))
	if err != nil {
		return nil, fmt.Errorf("create gateway connection: %w", err)
	}
	return conn, nil
}

// discoverCA sends no application data. Its custom verifier checks both the pinned root and
// the normal server chain/hostname/validity before any enrollment RPC is possible.
func discoverCA(ctx context.Context, address, fingerprint string, dev bool) (*x509.Certificate, error) {
	if fingerprint == "" && !dev {
		return nil, errors.New("installation CA fingerprint is required")
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, errors.New("invalid gateway address")
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
