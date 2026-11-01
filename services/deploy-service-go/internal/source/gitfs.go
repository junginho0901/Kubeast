package source

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"time"

	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// errNotFollowed is what reading a symbolic link or a submodule gives: the
// git source reads what the commit holds and never leaves it (Argo CD
// refuses links that point outside the repository for the same reason).
var errNotFollowed = errors.New("symbolic links and submodules are not followed")

// treeFS is one commit's tree as an fs.FS. Objects are read from the
// repository when asked for, under the repository's lock, so a snapshot
// costs nothing until a file is read. A file is read whole on Open, and a
// file above MaxFileSize is not read at all; Stat gets the size from the
// object header.
type treeFS struct {
	repo *Repo
	root *object.Tree
	when time.Time
}

var (
	_ fs.ReadDirFS  = (*treeFS)(nil)
	_ fs.StatFS     = (*treeFS)(nil)
	_ fs.ReadFileFS = (*treeFS)(nil)
)

// entry finds name; "." is the root. The caller holds the lock.
func (t *treeFS) entry(op, name string) (object.TreeEntry, error) {
	if !fs.ValidPath(name) {
		return object.TreeEntry{}, &fs.PathError{Op: op, Path: name, Err: fs.ErrInvalid}
	}
	if name == "." {
		return object.TreeEntry{Name: ".", Mode: filemode.Dir, Hash: t.root.Hash}, nil
	}
	e, err := t.root.FindEntry(name)
	if errors.Is(err, object.ErrEntryNotFound) || errors.Is(err, object.ErrDirectoryNotFound) {
		return object.TreeEntry{}, &fs.PathError{Op: op, Path: name, Err: fs.ErrNotExist}
	}
	if err != nil {
		return object.TreeEntry{}, &fs.PathError{Op: op, Path: name, Err: err}
	}
	return *e, nil
}

// info describes e. The caller holds the lock.
func (t *treeFS) info(e object.TreeEntry) (*gitInfo, error) {
	fi := &gitInfo{name: path.Base(e.Name), when: t.when}
	switch e.Mode {
	case filemode.Dir:
		fi.mode = fs.ModeDir | 0o555
	case filemode.Regular, filemode.Deprecated:
		fi.mode = 0o444
	case filemode.Executable:
		fi.mode = 0o555
	case filemode.Symlink:
		fi.mode = fs.ModeSymlink | 0o777
	default: // a submodule, or a mode git does not write
		fi.mode = fs.ModeIrregular
	}
	if fi.mode.IsRegular() || fi.mode&fs.ModeSymlink != 0 {
		n, err := t.repo.repo.Storer.EncodedObjectSize(e.Hash)
		if err != nil {
			return nil, err
		}
		fi.size = n
	}
	return fi, nil
}

func (t *treeFS) Stat(name string) (fs.FileInfo, error) {
	t.repo.mu.Lock()
	defer t.repo.mu.Unlock()
	e, err := t.entry("stat", name)
	if err != nil {
		return nil, err
	}
	fi, err := t.info(e)
	if err != nil {
		return nil, &fs.PathError{Op: "stat", Path: name, Err: err}
	}
	return fi, nil
}

func (t *treeFS) Open(name string) (fs.File, error) {
	t.repo.mu.Lock()
	defer t.repo.mu.Unlock()
	e, err := t.entry("open", name)
	if err != nil {
		return nil, err
	}
	fi, err := t.info(e)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	f := &gitFile{name: name, info: fi}
	switch {
	case fi.IsDir():
		f.dir, err = t.readDir(e.Hash)
	case !fi.Mode().IsRegular():
		f.err = errNotFollowed
	case fi.size > MaxFileSize:
		f.err = fmt.Errorf("%d bytes, above the %d-byte limit", fi.size, MaxFileSize)
	default:
		var data []byte
		data, err = t.blob(e)
		f.r = bytes.NewReader(data)
	}
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	return f, nil
}

func (t *treeFS) ReadDir(name string) ([]fs.DirEntry, error) {
	t.repo.mu.Lock()
	defer t.repo.mu.Unlock()
	e, err := t.entry("readdir", name)
	if err != nil {
		return nil, err
	}
	if e.Mode != filemode.Dir {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: errors.New("not a directory")}
	}
	entries, err := t.readDir(e.Hash)
	if err != nil {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: err}
	}
	return entries, nil
}

func (t *treeFS) ReadFile(name string) ([]byte, error) {
	f, err := t.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// readDir lists a tree by name. The caller holds the lock.
func (t *treeFS) readDir(h plumbing.Hash) ([]fs.DirEntry, error) {
	tree, err := t.repo.repo.TreeObject(h)
	if err != nil {
		return nil, err
	}
	out := make([]fs.DirEntry, 0, len(tree.Entries))
	for _, e := range tree.Entries {
		fi, err := t.info(e)
		if err != nil {
			return nil, err
		}
		out = append(out, fs.FileInfoToDirEntry(fi))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out, nil
}

// blob reads a file whole. The caller holds the lock.
func (t *treeFS) blob(e object.TreeEntry) ([]byte, error) {
	b, err := t.repo.repo.BlobObject(e.Hash)
	if err != nil {
		return nil, err
	}
	r, err := b.Reader()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, MaxFileSize+1))
}

// gitInfo is a tree entry's fs.FileInfo; the time is the commit's.
type gitInfo struct {
	name string
	size int64
	mode fs.FileMode
	when time.Time
}

func (i *gitInfo) Name() string       { return i.name }
func (i *gitInfo) Size() int64        { return i.size }
func (i *gitInfo) Mode() fs.FileMode  { return i.mode }
func (i *gitInfo) ModTime() time.Time { return i.when }
func (i *gitInfo) IsDir() bool        { return i.mode.IsDir() }
func (i *gitInfo) Sys() any           { return nil }

// gitFile is an open file or folder. A link, a submodule or a file above
// the limit opens, so Stat works on it, but reading it gives err.
type gitFile struct {
	name string
	info *gitInfo
	r    *bytes.Reader
	dir  []fs.DirEntry
	err  error
}

var _ fs.ReadDirFile = (*gitFile)(nil)

func (f *gitFile) Stat() (fs.FileInfo, error) { return f.info, nil }
func (f *gitFile) Close() error               { return nil }

func (f *gitFile) Read(p []byte) (int, error) {
	switch {
	case f.err != nil:
		return 0, &fs.PathError{Op: "read", Path: f.name, Err: f.err}
	case f.r == nil:
		return 0, &fs.PathError{Op: "read", Path: f.name, Err: errors.New("is a directory")}
	}
	return f.r.Read(p)
}

func (f *gitFile) ReadDir(n int) ([]fs.DirEntry, error) {
	if !f.info.IsDir() {
		return nil, &fs.PathError{Op: "readdir", Path: f.name, Err: errors.New("not a directory")}
	}
	if n <= 0 {
		out := f.dir
		f.dir = nil
		return out, nil
	}
	if len(f.dir) == 0 {
		return nil, io.EOF
	}
	n = min(n, len(f.dir))
	out := f.dir[:n]
	f.dir = f.dir[n:]
	return out, nil
}
