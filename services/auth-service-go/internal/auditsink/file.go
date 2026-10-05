package auditsink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// FileConfig: NDJSON appended to <path>/audit.ndjson (a PVC or host path),
// rotated to audit-<UTC time>.ndjson past maxSizeMB, keeping maxFiles rotated
// files.
type FileConfig struct {
	Path      string `yaml:"path"`
	MaxSizeMB int    `yaml:"maxSizeMB"`
	MaxFiles  int    `yaml:"maxFiles"`
}

type fileSink struct {
	cfg FileConfig
	mu  sync.Mutex
	now func() time.Time
}

func newFileSink(s SinkConfig) (Sink, error) {
	c := s.File
	if strings.TrimSpace(c.Path) == "" {
		return nil, errors.New("file.path is required")
	}
	if c.MaxSizeMB <= 0 {
		c.MaxSizeMB = 100
	}
	if c.MaxFiles <= 0 {
		c.MaxFiles = 10
	}
	return &fileSink{cfg: c, now: time.Now}, nil
}

func (f *fileSink) Send(_ context.Context, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := os.MkdirAll(f.cfg.Path, 0o750); err != nil {
		return err
	}
	current := filepath.Join(f.cfg.Path, "audit.ndjson")
	if st, err := os.Stat(current); err == nil && st.Size() >= int64(f.cfg.MaxSizeMB)<<20 {
		rotated := filepath.Join(f.cfg.Path, "audit-"+f.now().UTC().Format("20060102T150405.000000000Z")+".ndjson")
		if err := os.Rename(current, rotated); err != nil {
			return fmt.Errorf("rotate: %w", err)
		}
		f.prune()
	}
	fh, err := os.OpenFile(current, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(fh)
	for _, e := range events {
		if err := enc.Encode(e); err != nil {
			fh.Close()
			return err
		}
	}
	if err := fh.Sync(); err != nil {
		fh.Close()
		return err
	}
	return fh.Close()
}

// prune removes the oldest rotated files beyond maxFiles.
func (f *fileSink) prune() {
	matches, _ := filepath.Glob(filepath.Join(f.cfg.Path, "audit-*.ndjson"))
	if len(matches) <= f.cfg.MaxFiles {
		return
	}
	sort.Strings(matches) // UTC timestamps sort chronologically
	for _, old := range matches[:len(matches)-f.cfg.MaxFiles] {
		_ = os.Remove(old)
	}
}
