package credentials

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shipkeepdev/shipkeep/lib/secret"
)

func fixture(t *testing.T) Bundle {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	private, csr, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(csr))
	request, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || request.CheckSignature() != nil {
		t.Fatal("invalid CSR")
	}
	identity, _ := url.Parse("spiffe://shipkeep/0192f0c0-0000-7000-8000-000000000001/node/0192f0c0-0000-7000-8000-000000000002")
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "test node"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour), URIs: []*url.URL{identity}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, request.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return Bundle{Key: private, Certificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), CA: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})), NodeID: "0192f0c0-0000-7000-8000-000000000002", OrganizationID: "0192f0c0-0000-7000-8000-000000000001", LeaseEpoch: 1}
}

func TestValidateBindsKeyCAAndIdentity(t *testing.T) {
	b := fixture(t)
	if _, err := b.Validate(""); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Bundle){
		func(b *Bundle) { b.NodeID = "another-node" },
		func(b *Bundle) { b.OrganizationID = "another-org" },
		func(b *Bundle) { b.Key = secret.NewString("invalid private key") },
		func(b *Bundle) { b.CA = fixture(t).CA },
		func(b *Bundle) { b.Certificate = "invalid certificate" },
	} {
		changed := b
		mutate(&changed)
		if _, err := changed.Validate(""); err == nil {
			t.Fatal("accepted invalid credentials")
		}
	}
	if _, err := b.Validate("sha256:" + strings.Repeat("0", 64)); err == nil {
		t.Fatal("accepted wrong CA fingerprint")
	}
	if strings.Contains(fmt.Sprintf("%+v", b), "PRIVATE KEY") {
		t.Fatal("key leaked by formatting")
	}
}

func TestAtomicCredentialReplacementAndPermissions(t *testing.T) {
	dir := t.TempDir()
	first, next := fixture(t), fixture(t)
	if err := first.Save(dir); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir, "")
	if err != nil || !loaded.Key.Equal(first.Key) {
		t.Fatalf("load: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "credentials.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatal("credentials must be 0600")
	}
	invalid := next
	invalid.NodeID = "forged"
	if err := invalid.Save(dir); err == nil {
		t.Fatal("invalid bundle was persisted")
	}
	loaded, err = Load(dir, "")
	if err != nil || !loaded.Key.Equal(first.Key) {
		t.Fatal("failed update damaged existing credentials")
	}
	if err := next.Save(dir); err != nil {
		t.Fatal(err)
	}
	loaded, err = Load(dir, "")
	if err != nil || !loaded.Key.Equal(next.Key) {
		t.Fatal("replacement not persisted")
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 1 {
		t.Fatal("temporary key files left behind")
	}
}

func TestLoadRefusesLooseSymlinkAndOversizedFiles(t *testing.T) {
	dir := t.TempDir()
	b := fixture(t)
	if err := b.Save(dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "credentials.json")
	if err := os.Chmod(path, 0o644); err != nil { //nolint:gosec // test intentionally weak permissions
		t.Fatal(err)
	}
	if _, err := Load(dir, ""); err == nil {
		t.Fatal("accepted world-readable key")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(target, []byte("private material"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir, ""); err == nil {
		t.Fatal("accepted symlink")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, MaxBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir, ""); err == nil {
		t.Fatal("accepted oversized bundle")
	}
}
