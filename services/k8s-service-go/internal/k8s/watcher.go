package k8s

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// WatchKubeconfig watches the kubeconfig file for changes and swaps the active
// clientBundle on the fly. The parent directory is watched (not the file
// itself) so that atomic writes via rename — which change the inode — still
// deliver a Create event.
//
// Only enabled when the service was constructed with watchEnabled=true.
func (s *Service) WatchKubeconfig(ctx context.Context) {
	if !s.watchEnabled || s.kubeconfigPath == "" {
		return
	}

	w, err := fsnotify.NewWatcher()
	if err != nil {
		slog.Error("fsnotify: create watcher failed", "err", err)
		return
	}
	defer w.Close()

	dir := filepath.Dir(s.kubeconfigPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Error("fsnotify: ensure dir failed", "dir", dir, "err", err)
		return
	}
	if err := w.Add(dir); err != nil {
		slog.Error("fsnotify: add dir failed", "dir", dir, "err", err)
		return
	}
	slog.Info("kubeconfig watcher started", "path", s.kubeconfigPath)

	var (
		mu       sync.Mutex
		debounce *time.Timer
	)

	scheduleReload := func() {
		mu.Lock()
		defer mu.Unlock()
		if debounce != nil {
			debounce.Stop()
		}
		debounce = time.AfterFunc(300*time.Millisecond, func() {
			if _, err := os.Stat(s.kubeconfigPath); err != nil {
				slog.Warn("kubeconfig missing after event", "path", s.kubeconfigPath, "err", err)
				return
			}
			if err := s.reloadFromPath(s.kubeconfigPath); err != nil {
				slog.Error("kubeconfig reload failed", "err", err)
				return
			}
			slog.Info("kubeconfig hot-reloaded", "path", s.kubeconfigPath)
		})
	}

	for {
		select {
		case <-ctx.Done():
			slog.Info("kubeconfig watcher stopping")
			return
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			if ev.Name != s.kubeconfigPath {
				continue
			}
			if ev.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename) == 0 {
				continue
			}
			scheduleReload()
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			slog.Warn("fsnotify error", "err", err)
		}
	}
}
