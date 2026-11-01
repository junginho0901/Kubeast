package buildlog

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ErrNotFound marks a build or step the store does not have.
var ErrNotFound = errors.New("not found")

// Store keeps finished step logs: storage "file" now; "s3" and "database"
// (design ⓒ §10) come with the server, after stage 0.
type Store interface {
	// Create starts one step's log. It appears only when the writer is
	// closed; Abort, or a crash, leaves nothing a reader sees.
	Create(ctx context.Context, build, step string) (Writer, error)
	// Open reads a step's log back, uncompressed.
	Open(ctx context.Context, build, step string) (io.ReadCloser, error)
	// Steps lists a build's kept steps by name.
	Steps(ctx context.Context, build string) ([]Step, error)
	// DeleteBefore removes the builds whose last log was written before t,
	// and returns their IDs for the audit record.
	DeleteBefore(ctx context.Context, t time.Time) ([]string, error)
}

// Writer is a step's log being stored.
type Writer interface {
	io.WriteCloser
	Abort() error
}

// Step is one kept step log.
type Step struct {
	Name string
	// Size is what the store holds (compressed).
	Size    int64
	Written time.Time
}

var nameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// checkBuild and checkStep refuse anything but DNS labels: build IDs name
// the Job (ci-<ID>) and step names are pipeline step names, and neither may
// reach outside the store's folder.
func checkBuild(build string) error {
	if len(build) > 63 || !nameRe.MatchString(build) {
		return fmt.Errorf("build ID %q is not a DNS label", build)
	}
	return nil
}

func checkStep(step string) error {
	if len(step) > 63 || !nameRe.MatchString(step) {
		return fmt.Errorf("step name %q is not a DNS label", step)
	}
	return nil
}

func checkNames(build, step string) error { return errors.Join(checkBuild(build), checkStep(step)) }

const suffix = ".log.gz"

// File keeps logs as gzip files on a volume (a PVC): <dir>/<build>/<step>.log.gz.
// A log is written under a hidden temporary name, synced, then renamed, so
// a reader sees a whole file or none. Safe for concurrent use.
type File struct{ dir string }

// NewFile keeps logs under dir, which it makes if needed.
func NewFile(dir string) (*File, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	return &File{dir: dir}, nil
}

func (f *File) Create(ctx context.Context, build, step string) (Writer, error) {
	if err := checkNames(build, step); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	dir := filepath.Join(f.dir, build)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(dir, "."+step+suffix+".*")
	if err != nil {
		return nil, err
	}
	if err := tmp.Chmod(0o640); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, err
	}
	return &fileWriter{tmp: tmp, gz: gzip.NewWriter(tmp), final: filepath.Join(dir, step+suffix)}, nil
}

type fileWriter struct {
	tmp   *os.File
	gz    *gzip.Writer
	final string
	done  bool
}

func (w *fileWriter) Write(p []byte) (int, error) {
	if w.done {
		return 0, errClosed
	}
	return w.gz.Write(p)
}

func (w *fileWriter) Close() error {
	if w.done {
		return nil
	}
	w.done = true
	err := errors.Join(w.gz.Close(), w.tmp.Sync())
	err = errors.Join(err, w.tmp.Close())
	if err == nil {
		err = os.Rename(w.tmp.Name(), w.final)
	}
	if err == nil {
		err = syncDir(filepath.Dir(w.final))
	}
	if err != nil {
		os.Remove(w.tmp.Name())
	}
	return err
}

func (w *fileWriter) Abort() error {
	if w.done {
		return nil
	}
	w.done = true
	return errors.Join(w.tmp.Close(), os.Remove(w.tmp.Name()))
}

// syncDir makes a rename durable.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	return errors.Join(d.Sync(), d.Close())
}

func (f *File) Open(ctx context.Context, build, step string) (io.ReadCloser, error) {
	if err := checkNames(build, step); err != nil {
		return nil, err
	}
	file, err := os.Open(filepath.Join(f.dir, build, step+suffix))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%s/%s: %w", build, step, ErrNotFound)
	}
	if err != nil {
		return nil, err
	}
	gz, err := gzip.NewReader(file)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("%s/%s: %w", build, step, err)
	}
	return &fileReader{gz: gz, file: file}, nil
}

type fileReader struct {
	gz   *gzip.Reader
	file *os.File
}

func (r *fileReader) Read(p []byte) (int, error) { return r.gz.Read(p) }
func (r *fileReader) Close() error               { return errors.Join(r.gz.Close(), r.file.Close()) }

func (f *File) Steps(ctx context.Context, build string) ([]Step, error) {
	if err := checkBuild(build); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(f.dir, build))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("build %s: %w", build, ErrNotFound)
	}
	if err != nil {
		return nil, err
	}
	var out []Step
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), suffix)
		if !ok || !e.Type().IsRegular() || checkStep(name) != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		out = append(out, Step{Name: name, Size: info.Size(), Written: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// DeleteBefore removes a build when every file in its folder, unfinished
// ones included, was last written before t; a build still being written
// stays. Folders that are not build IDs are left alone.
func (f *File) DeleteBefore(ctx context.Context, t time.Time) ([]string, error) {
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		return nil, err
	}
	var gone []string
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return gone, err
		}
		if !e.IsDir() || checkBuild(e.Name()) != nil {
			continue
		}
		dir := filepath.Join(f.dir, e.Name())
		files, err := os.ReadDir(dir)
		if err != nil {
			return gone, err
		}
		old := true
		for _, file := range files {
			info, err := file.Info()
			if err != nil {
				return gone, err
			}
			old = old && info.ModTime().Before(t)
		}
		if !old {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			return gone, err
		}
		gone = append(gone, e.Name())
	}
	return gone, nil
}

// Result is what Save did with one step's log.
type Result struct {
	Read int64 // bytes of log read
	Kept int64 // bytes of it stored (head and tail)
}

// Save stores one step's log from r, cut by the build's budget. On any
// error the step is not stored.
func Save(ctx context.Context, s Store, b *Budget, build, step string, r io.Reader) (Result, error) {
	w, err := s.Create(ctx, build, step)
	if err != nil {
		return Result{}, err
	}
	c := b.Step(w)
	_, err = io.Copy(c, ctxReader{ctx, r})
	if err == nil {
		err = c.Close()
	}
	res := Result{Read: c.Read(), Kept: c.Kept()}
	if err != nil {
		return res, errors.Join(err, w.Abort())
	}
	return res, w.Close()
}

// ctxReader stops a copy once ctx is done.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
