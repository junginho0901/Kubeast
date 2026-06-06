package cluster

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestK8sSecretStore_RoundTrip(t *testing.T) {
	cs := fake.NewSimpleClientset()
	store := NewK8sSecretStore(cs, "kubeast")
	ctx := context.Background()

	name, err := store.WriteKubeconfig(ctx, ID("prod"), "apiVersion: v1")
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if name != SecretName("prod") {
		t.Errorf("expected secret name %q, got %q", SecretName("prod"), name)
	}

	got, err := store.ReadKubeconfig(ctx, name)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != "apiVersion: v1" {
		t.Errorf("expected blob, got %q", got)
	}

	// Overwrite (Create → AlreadyExists → Update path).
	if _, err := store.WriteKubeconfig(ctx, ID("prod"), "apiVersion: v2"); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	got, _ = store.ReadKubeconfig(ctx, name)
	if got != "apiVersion: v2" {
		t.Errorf("expected updated blob, got %q", got)
	}

	if err := store.DeleteKubeconfig(ctx, name); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// Deleting a missing secret is a no-op.
	if err := store.DeleteKubeconfig(ctx, name); err != nil {
		t.Errorf("delete missing should be nil, got %v", err)
	}
	if _, err := store.ReadKubeconfig(ctx, name); err == nil {
		t.Error("expected read after delete to fail")
	}
}

func TestK8sSecretStore_MissingKey(t *testing.T) {
	cs := fake.NewSimpleClientset()
	// Pre-create a secret without the kubeconfig key.
	empty := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "x", Namespace: "kubeast"},
		Data:       map[string][]byte{"other": []byte("v")},
	}
	_, _ = cs.CoreV1().Secrets("kubeast").Create(context.Background(), empty, metav1.CreateOptions{})
	store := NewK8sSecretStore(cs, "kubeast")
	if _, err := store.ReadKubeconfig(context.Background(), "x"); err == nil {
		t.Error("expected error for secret missing kubeconfig key")
	}
}

func TestFilesystemSecretStore_RoundTrip(t *testing.T) {
	store := NewFilesystemSecretStore(t.TempDir())
	ctx := context.Background()

	path, err := store.WriteKubeconfig(ctx, ID("dev"), "kubeconfig-body")
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := store.ReadKubeconfig(ctx, path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != "kubeconfig-body" {
		t.Errorf("expected body, got %q", got)
	}
	if err := store.DeleteKubeconfig(ctx, path); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := store.DeleteKubeconfig(ctx, path); err != nil {
		t.Errorf("delete missing should be nil, got %v", err)
	}
}
