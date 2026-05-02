package helm

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"testing"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/release"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// encodeRelease replicates Helm v3's storage/driver Secret encoding so
// the test fixture is bit-for-bit what the real driver writes.
func encodeRelease(t *testing.T, rel *release.Release) []byte {
	t.Helper()
	js, err := json.Marshal(rel)
	if err != nil {
		t.Fatalf("marshal release: %v", err)
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(js); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return []byte(base64.StdEncoding.EncodeToString(buf.Bytes()))
}

func TestDecodeReleaseSecret_RoundTrip(t *testing.T) {
	rel := &release.Release{
		Name:      "my-app",
		Namespace: "production",
		Version:   3,
		Info: &release.Info{
			Status: release.StatusDeployed,
		},
		Chart: &chart.Chart{
			Metadata: &chart.Metadata{
				Name:       "nginx",
				Version:    "1.2.3",
				AppVersion: "v1.25",
			},
		},
	}

	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "sh.helm.release.v1.my-app.v3",
			Namespace: "production",
		},
		Type: SecretType,
		Data: map[string][]byte{
			"release": encodeRelease(t, rel),
		},
	}

	got, err := DecodeReleaseSecret(secret)
	if err != nil {
		t.Fatalf("DecodeReleaseSecret: %v", err)
	}

	if got.Name != "my-app" {
		t.Errorf("Name: got %q, want %q", got.Name, "my-app")
	}
	if got.Namespace != "production" {
		t.Errorf("Namespace: got %q, want %q", got.Namespace, "production")
	}
	if got.Revision != 3 {
		t.Errorf("Revision: got %d, want 3", got.Revision)
	}
	if got.Status != "deployed" {
		t.Errorf("Status: got %q, want %q", got.Status, "deployed")
	}
	if got.Chart != "nginx" {
		t.Errorf("Chart: got %q, want %q", got.Chart, "nginx")
	}
	if got.ChartVersion != "1.2.3" {
		t.Errorf("ChartVersion: got %q, want %q", got.ChartVersion, "1.2.3")
	}
	if got.AppVersion != "v1.25" {
		t.Errorf("AppVersion: got %q, want %q", got.AppVersion, "v1.25")
	}
}

func TestDecodeReleaseSecret_MissingReleaseKey(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "x", Namespace: "y"},
		Type:       SecretType,
		Data:       map[string][]byte{},
	}
	if _, err := DecodeReleaseSecret(secret); err == nil {
		t.Fatal("expected error for missing 'release' key, got nil")
	}
}

func TestDecodeReleaseSecret_InvalidBase64(t *testing.T) {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "x", Namespace: "y"},
		Type:       SecretType,
		Data:       map[string][]byte{"release": []byte("not-valid-base64-!!!")},
	}
	if _, err := DecodeReleaseSecret(secret); err == nil {
		t.Fatal("expected error for invalid base64, got nil")
	}
}

func TestDecodeReleaseSecret_NilSecret(t *testing.T) {
	if _, err := DecodeReleaseSecret(nil); err == nil {
		t.Fatal("expected error for nil secret, got nil")
	}
}
