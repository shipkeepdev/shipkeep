// Package credentials owns the node's key pair and atomically persisted enrollment identity.
package credentials

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/samuelmbabhazi/shipkeep/lib/secret"
)

// MaxBytes bounds a persisted credential bundle before parsing it.
const MaxBytes = 64 * 1024
const filename = "credentials.json"

// Bundle is one coherent generation of credentials. Key redacts in logs and serialization.
type Bundle struct {
	Key                   secret.String `json:"key"`
	Certificate           string        `json:"certificate"`
	CA                    string        `json:"ca"`
	NodeID                string        `json:"node_id"`
	OrganizationID        string        `json:"organization_id"`
	LeaseEpoch            uint64        `json:"lease_epoch"`
	ConfirmationPublicKey string        `json:"confirmation_public_key"`
}

// Generate creates a fresh Ed25519 key and a signed CSR without caller-controlled identity.
func Generate() (secret.String, string, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return secret.String{}, "", fmt.Errorf("generate node key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return secret.String{}, "", fmt.Errorf("encode node key: %w", err)
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{}, key)
	if err != nil {
		return secret.String{}, "", fmt.Errorf("create node CSR: %w", err)
	}
	return secret.NewString(string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))), string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr})), nil
}

// Fingerprint returns the installer-compatible SHA-256 fingerprint of a DER certificate.
func Fingerprint(certificate *x509.Certificate) string {
	return fmt.Sprintf("sha256:%x", sha256.Sum256(certificate.Raw))
}

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Validate binds the key, CA and client-auth certificate to the recorded tenant/node identity.
// Expired credentials are rejected; callers must explicitly re-enroll instead of silently trusting them.
func (b Bundle) Validate(fingerprint string) (tls.Certificate, error) {
	pair, err := tls.X509KeyPair([]byte(b.Certificate), []byte(b.Key.Expose()))
	if err != nil {
		return tls.Certificate{}, errors.New("invalid node key pair")
	}
	if _, ok := pair.PrivateKey.(ed25519.PrivateKey); !ok {
		return tls.Certificate{}, errors.New("node key must be Ed25519")
	}
	block, rest := pem.Decode([]byte(b.CA))
	if block == nil || block.Type != "CERTIFICATE" || len(rest) != 0 {
		return tls.Certificate{}, errors.New("invalid installation CA")
	}
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil || !ca.IsCA {
		return tls.Certificate{}, errors.New("invalid installation CA")
	}
	if fingerprint != "" && Fingerprint(ca) != fingerprint {
		return tls.Certificate{}, errors.New("installation CA fingerprint mismatch")
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	leaf := pair.Leaf
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		return tls.Certificate{}, errors.New("invalid node certificate chain or validity")
	}
	expected := "spiffe://shipkeep/" + b.OrganizationID + "/node/" + b.NodeID
	if !uuid.MatchString(b.NodeID) || !uuid.MatchString(b.OrganizationID) || len(leaf.URIs) != 1 || leaf.URIs[0].String() != expected {
		return tls.Certificate{}, errors.New("node certificate identity mismatch")
	}
	return pair, nil
}

// RenewalTime is the two-thirds point in a validated certificate's validity window.
func RenewalTime(pair tls.Certificate) time.Time {
	return pair.Leaf.NotBefore.Add(pair.Leaf.NotAfter.Sub(pair.Leaf.NotBefore) * 2 / 3)
}

// Load refuses links, loose permissions and oversized files, then validates the entire bundle.
func Load(dir, fingerprint string) (Bundle, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return Bundle{}, fmt.Errorf("open credential directory: %w", err)
	}
	defer root.Close() //nolint:errcheck // read-only directory handle
	info, err := root.Lstat(filename)
	if err != nil {
		return Bundle{}, fmt.Errorf("inspect credentials: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() > MaxBytes {
		return Bundle{}, errors.New("credentials must be a regular 0600 file below 64 KiB")
	}
	file, err := root.Open(filename)
	if err != nil {
		return Bundle{}, fmt.Errorf("open credentials: %w", err)
	}
	defer file.Close() //nolint:errcheck // read-only file
	data, err := io.ReadAll(io.LimitReader(file, MaxBytes+1))
	if err != nil {
		return Bundle{}, fmt.Errorf("read credentials: %w", err)
	}
	if len(data) > MaxBytes {
		return Bundle{}, errors.New("credentials exceed 64 KiB")
	}
	var bundle Bundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		return Bundle{}, errors.New("invalid credential bundle")
	}
	if _, err := bundle.Validate(fingerprint); err != nil {
		return Bundle{}, err
	}
	return bundle, nil
}

// Save validates and fsyncs a complete generation before atomically replacing the old bundle.
// Private key exposure is limited to this explicit persistence boundary, never generic serialization.
func (b Bundle) Save(dir string) error {
	if _, err := b.Validate(""); err != nil {
		return err
	}
	data, err := json.Marshal(struct {
		Bundle
		Key string `json:"key"`
	}{Bundle: b, Key: b.Key.Expose()})
	if err != nil {
		return fmt.Errorf("encode credentials: %w", err)
	}
	if len(data) > MaxBytes {
		return errors.New("credentials exceed 64 KiB")
	}
	file, err := os.CreateTemp(dir, ".credentials-*")
	if err != nil {
		return fmt.Errorf("create credential generation: %w", err)
	}
	defer os.Remove(file.Name()) //nolint:errcheck // file has been renamed on success
	defer file.Close()           //nolint:errcheck // explicitly closed before rename
	if _, err := file.Write(data); err != nil {
		return fmt.Errorf("write credentials: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync credentials: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close credentials: %w", err)
	}
	if err := os.Rename(file.Name(), filepath.Join(dir, filename)); err != nil {
		return fmt.Errorf("replace credentials: %w", err)
	}
	directory, err := os.Open(dir) //nolint:gosec // operator-owned state directory, never remote input
	if err != nil {
		return fmt.Errorf("open credential directory: %w", err)
	}
	defer directory.Close() //nolint:errcheck // directory sync result checked below
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync credential directory: %w", err)
	}
	return nil
}
