package dockersetup

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// WriteKubeconfigAtomic writes kubeconfig contents to path atomically.
// It creates a temp file in the same directory, fsyncs it, and renames over the
// target so fsnotify watchers on the parent directory reliably observe a single
// Create/Rename event.
func WriteKubeconfigAtomic(path string, contents []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, ".kubeconfig.*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(contents); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}

	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename %s -> %s: %w", tmpName, path, err)
	}
	cleanup = false
	return nil
}

// Status represents docker-mode rollout state.
type Status struct {
	FileExists      bool
	FileSize        int64
	K8sServiceReady bool
	Message         string
}

// GetStatus returns the current docker-mode rollout state: whether the
// kubeconfig file exists on the shared volume and whether k8s-service has
// hot-reloaded and is healthy.
func GetStatus(ctx context.Context, path, healthURL string) Status {
	st := Status{}
	if fi, err := os.Stat(path); err == nil {
		st.FileExists = true
		st.FileSize = fi.Size()
	}

	client := &http.Client{Timeout: 2 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		st.Message = err.Error()
		return st
	}
	resp, err := client.Do(req)
	if err != nil {
		st.Message = err.Error()
		return st
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		st.K8sServiceReady = true
		st.Message = "connected"
		return st
	}
	st.Message = fmt.Sprintf("status %d", resp.StatusCode)
	return st
}
