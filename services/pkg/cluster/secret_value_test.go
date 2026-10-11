package cluster

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The filesystem store keeps named values next to the kubeconfigs and
// DeleteSecret removes every key of that name.
func TestFilesystemSecretStoreValues(t *testing.T) {
	dir := t.TempDir()
	s := NewFilesystemSecretStore(dir)
	ctx := context.Background()
	name := PrometheusSecretName("alpha")
	if name != "cluster-prometheus-alpha" {
		t.Fatalf("name = %s", name)
	}
	if err := s.WriteValue(ctx, name, PrometheusAuthKey, "Bearer t"); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(dir, name+"."+PrometheusAuthKey)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("file: %v %v", info, err)
	}
	if v, err := s.ReadValue(ctx, name, PrometheusAuthKey); err != nil || v != "Bearer t" {
		t.Fatalf("read = %q %v", v, err)
	}
	if _, err := s.ReadValue(ctx, name, "other"); err == nil {
		t.Fatal("missing key must error")
	}
	if err := s.DeleteSecret(ctx, name); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadValue(ctx, name, PrometheusAuthKey); err == nil {
		t.Fatal("deleted value still readable")
	}
	if err := s.DeleteSecret(ctx, name); err != nil {
		t.Fatalf("deleting twice must be fine: %v", err)
	}
}
