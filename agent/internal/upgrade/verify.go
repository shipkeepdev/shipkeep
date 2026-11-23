package upgrade

import (
	_ "embed" // the trusted root, below
	"errors"
	"fmt"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// trustedRoot is Sigstore's trusted root (certificate authorities, transparency and certificate
// transparency logs) as of this build: `go generate` takes it from Sigstore's TUF repository.
//
//go:embed trusted_root.json
var trustedRoot []byte

// maxBundleBytes bounds the Sigstore bundle read before it is parsed: a real one is about 10 KiB.
const maxBundleBytes = 64 << 10

// Verify checks that bundleJSON is a Sigstore signature, by Shipkeep's release workflow for the
// tag of version, of the artifact whose SHA-256 is digest. It needs no network: the certificate
// chains to the embedded root, its timestamps come from the transparency log entry and the
// certificate transparency proof the bundle carries.
func Verify(bundleJSON []byte, digest [32]byte, version Version) error {
	if len(bundleJSON) == 0 || len(bundleJSON) > maxBundleBytes {
		return fmt.Errorf("%w: the signature bundle is empty or larger than %d bytes", ErrRefused, maxBundleBytes)
	}
	var signed bundle.Bundle
	if err := signed.UnmarshalJSON(bundleJSON); err != nil {
		return fmt.Errorf("%w: the signature bundle cannot be read", ErrRefused)
	}
	material, err := root.NewTrustedRootFromJSON(trustedRoot)
	if err != nil {
		return fmt.Errorf("embedded trusted root: %w", err)
	}
	verifier, err := verify.NewVerifier(material,
		verify.WithSignedCertificateTimestamps(1),
		verify.WithTransparencyLog(1),
		verify.WithObserverTimestamps(1),
	)
	if err != nil {
		return fmt.Errorf("verifier: %w", err)
	}
	// The exact workflow and tag, not a pattern: a signature for another version, workflow,
	// branch or repository is refused.
	identity, err := verify.NewShortCertificateIdentity(Issuer, "", SignerIdentity(version), "")
	if err != nil {
		return fmt.Errorf("certificate identity: %w", err)
	}
	policy := verify.NewPolicy(verify.WithArtifactDigest("sha256", digest[:]), verify.WithCertificateIdentity(identity))
	if _, err := verifier.Verify(&signed, policy); err != nil {
		return errors.Join(fmt.Errorf("%w: the signature does not hold for this release", ErrRefused), err)
	}
	return nil
}
