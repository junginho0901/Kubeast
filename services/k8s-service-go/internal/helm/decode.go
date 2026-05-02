package helm

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"helm.sh/helm/v3/pkg/release"
	corev1 "k8s.io/api/core/v1"
)

// SecretType is the K8s Secret type Helm v3 uses for its release storage.
// Used as fieldSelector for server-side filtering of the Secret watch — the
// API server returns only matching secrets, so we never see unrelated
// Secret churn (TLS certs, dockercfg, …).
const SecretType = "helm.sh/release.v1"

// magicGzip is the leading bytes of a gzip stream. Helm 3 always gzips
// the release JSON before base64-encoding, but very small / very old
// releases may be uncompressed — we detect either form.
var magicGzip = []byte{0x1f, 0x8b, 0x08}

// DecodeReleaseSecret extracts the ReleaseSummary from a Helm v3 storage
// Secret. The Secret's Data["release"] is a base64-encoded, optionally
// gzip-compressed JSON document of a *release.Release.
//
// Mirrors helm.sh/helm/v3/pkg/storage/driver/util.go (decodeRelease) —
// we re-implement here because that helper is package-internal in the
// upstream Helm SDK. Keeping the algorithm in one place (this package)
// means a Helm SDK upgrade only needs us to re-check this single file.
func DecodeReleaseSecret(secret *corev1.Secret) (*ReleaseSummary, error) {
	if secret == nil {
		return nil, fmt.Errorf("secret is nil")
	}
	raw, ok := secret.Data["release"]
	if !ok {
		return nil, fmt.Errorf("secret %s/%s has no 'release' key", secret.Namespace, secret.Name)
	}
	rel, err := decodeReleaseData(raw)
	if err != nil {
		return nil, fmt.Errorf("decode release %s/%s: %w", secret.Namespace, secret.Name, err)
	}
	s := toSummary(rel)
	return &s, nil
}

// decodeReleaseData performs the base64 → (gzip?) → JSON decode pipeline.
// secret.Data values come pre-base64-decoded by client-go, but Helm
// stores its payload as a base64-encoded gzip stream inside Data, so we
// still need one more base64 round.
func decodeReleaseData(data []byte) (*release.Release, error) {
	// Helm encodes the gzip stream as a base64 string, then stores those
	// bytes as the Data value. client-go gives us the raw bytes back —
	// which means we hold the base64 ASCII bytes here.
	decoded, err := base64.StdEncoding.DecodeString(string(data))
	if err != nil {
		return nil, fmt.Errorf("base64 decode: %w", err)
	}

	if len(decoded) >= 3 && bytes.Equal(decoded[:3], magicGzip) {
		gz, err := gzip.NewReader(bytes.NewReader(decoded))
		if err != nil {
			return nil, fmt.Errorf("gzip reader: %w", err)
		}
		defer gz.Close()
		decoded, err = io.ReadAll(gz)
		if err != nil {
			return nil, fmt.Errorf("gzip read: %w", err)
		}
	}

	var rel release.Release
	if err := json.Unmarshal(decoded, &rel); err != nil {
		return nil, fmt.Errorf("json unmarshal: %w", err)
	}
	return &rel, nil
}
