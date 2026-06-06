package cluster

import (
	"context"
	"errors"
	"testing"
)

func TestNewEnvRegistry_InCluster(t *testing.T) {
	t.Setenv("IN_CLUSTER", "true")
	t.Setenv("KUBECONFIG_PATH", "")

	info, err := NewEnvRegistry().Get(context.Background(), Default)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !info.InCluster || info.Mode != ModeInCluster {
		t.Errorf("expected in-cluster mode, got %+v", info)
	}
	if info.KubeconfigPath != "" {
		t.Errorf("expected empty kubeconfig path, got %q", info.KubeconfigPath)
	}
	if info.IsSelfCluster {
		t.Error("IsSelfCluster must be false for the env registry")
	}
}

func TestNewEnvRegistry_KubeconfigPath(t *testing.T) {
	t.Setenv("IN_CLUSTER", "")
	t.Setenv("KUBECONFIG_PATH", "/tmp/x")

	info, err := NewEnvRegistry().Get(context.Background(), Default)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if info.InCluster {
		t.Error("expected not in-cluster")
	}
	if info.Mode != ModeExternal || info.KubeconfigPath != "/tmp/x" {
		t.Errorf("expected external /tmp/x, got %+v", info)
	}
	if info.IsSelfCluster {
		t.Error("IsSelfCluster must be false")
	}
}

func TestNewEnvRegistry_Unset(t *testing.T) {
	t.Setenv("IN_CLUSTER", "")
	t.Setenv("KUBECONFIG_PATH", "")

	info, err := NewEnvRegistry().Get(context.Background(), Default)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if info.InCluster || info.KubeconfigPath != "" {
		t.Errorf("expected empty connection fields, got %+v", info)
	}
}

func TestEnvRegistry_List(t *testing.T) {
	list, err := NewEnvRegistry().List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ID != Default {
		t.Errorf("expected one default entry, got %+v", list)
	}
}

func TestEnvRegistry_GetUnknown(t *testing.T) {
	_, err := NewEnvRegistry().Get(context.Background(), ID("other"))
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestEnvRegistry_Default(t *testing.T) {
	id, err := NewEnvRegistry().Default(context.Background())
	if err != nil || id != Default {
		t.Errorf("expected default id, got %q err=%v", id, err)
	}
}
