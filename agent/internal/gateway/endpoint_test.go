package gateway

import (
	"context"
	"crypto/x509"
	"net"
	"strings"
	"testing"
	"time"

	nodecredentials "github.com/shipkeepdev/shipkeep/agent/internal/credentials"
	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// A gateway whose certificate names only the public name, as the control plane's does.
func publicNameGateway(t *testing.T, name string) (string, *testGateway) {
	t.Helper()
	return startGateway(t, false, func(leaf *x509.Certificate) { leaf.DNSNames, leaf.IPAddresses = []string{name}, nil })
}

func TestConnectDialsLoopbackAndVerifiesThePublicName(t *testing.T) {
	local, server := publicNameGateway(t, "shipkeep.example.com")
	_, port, err := net.SplitHostPort(local)
	if err != nil {
		t.Fatal(err)
	}
	// The public name does not resolve here: only Connect can reach the gateway.
	endpoint := Endpoint{Address: "shipkeep.example.com:" + port, Connect: local}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	bundle, err := Enroll(ctx, endpoint, nodecredentials.Fingerprint(server.ca), false, testToken, &agentv1.NodeFacts{Hostname: "test-node"}, "test")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := Open(endpoint, bundle)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close() //nolint:errcheck // test connection
	if _, err := Renew(ctx, agentv1.NewAgentGatewayServiceClient(conn), bundle); err != nil {
		t.Fatalf("a call over the connect address failed: %v", err)
	}
	// Without Connect, the agent dials the loopback address itself, which the certificate does not
	// name: the address alone is not enough.
	if _, err := Enroll(ctx, Endpoint{Address: local}, nodecredentials.Fingerprint(server.ca), false, testToken, nil, "test"); err == nil {
		t.Fatal("accepted a certificate that does not name the dialed address")
	}
}

func TestConnectKeepsEveryCheck(t *testing.T) {
	local, server := publicNameGateway(t, "shipkeep.example.com")
	_, port, err := net.SplitHostPort(local)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name        string
		endpoint    Endpoint
		fingerprint string
	}{
		{"another name", Endpoint{Address: "other.example.com:" + port, Connect: local}, nodecredentials.Fingerprint(server.ca)},
		{"another CA", Endpoint{Address: "shipkeep.example.com:" + port, Connect: local}, "sha256:" + strings.Repeat("0", 64)},
		{"no fingerprint", Endpoint{Address: "shipkeep.example.com:" + port, Connect: local}, ""},
	} {
		ctx, cancel := context.WithTimeout(t.Context(), time.Second)
		_, err := Enroll(ctx, test.endpoint, test.fingerprint, false, testToken, nil, "test")
		cancel()
		if err == nil {
			t.Fatalf("%s: enrolled", test.name)
		}
		if strings.Contains(err.Error(), testToken.Expose()) {
			t.Fatalf("%s: token in the error", test.name)
		}
	}
	if server.calls.Load() != 0 {
		t.Fatal("the token reached a gateway that failed a check")
	}
}

func TestConnectAcceptsOnlyLoopbackLiterals(t *testing.T) {
	for _, connect := range []string{"127.0.0.1:7443", "127.0.0.2:7443", "[::1]:7443"} {
		if !LoopbackConnect(connect) {
			t.Fatalf("refused %q", connect)
		}
	}
	for _, connect := range []string{
		"", "127.0.0.1", "127.0.0.1:0", "127.0.0.1:65536", "localhost:7443", "0.0.0.0:7443", "[::]:7443",
		"10.0.0.1:7443", "192.168.1.10:7443", "8.8.8.8:7443", "shipkeep.example.com:7443",
		"127.0.0.1:7443\n", " 127.0.0.1:7443", "127.000.0.1:7443", "[::ffff:127.0.0.1]:7443x", "127.0.0.1:7443/../x",
		"127.0.0.1:7443;rm -rf /", "[0:0:0:0:0:0:0:1]:7443", strings.Repeat("1", 4096) + ":7443",
	} {
		if LoopbackConnect(connect) {
			t.Fatalf("accepted %q", connect)
		}
	}
	// The dial refuses it too, whatever the configuration check did.
	if _, err := Open(Endpoint{Address: "shipkeep.example.com:7443", Connect: "10.0.0.1:7443"}, nodecredentials.Bundle{}); err == nil {
		t.Fatal("dialed a connect address that is not loopback")
	}
}
