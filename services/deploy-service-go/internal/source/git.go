package source

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"

	"github.com/go-git/go-billy/v5/osfs"
	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/cache"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport"
	"github.com/go-git/go-git/v5/storage/filesystem"
)

// RepoOptions says where a git source reads from.
type RepoOptions struct {
	// URL is https://, ssh:// or user@host:path. Credentials go in Auth,
	// never in the URL, where logs and errors would carry them.
	URL  string
	Auth transport.AuthMethod
	// Depth is how many commits a branch or tag fetch brings; 0 is the
	// whole history. A commit fetch always brings the whole history.
	Depth int
	// AllowHTTP lets URL be plain http:// (a Git server inside the cluster).
	AllowHTTP bool
	// AllowLocal lets URL be a path or file:// on the server (tests, a
	// mirror on a volume). Off, a source cannot read the server's disk.
	AllowLocal bool
}

// Ref names what to fetch. Commit wins over Tag and Tag over Branch, as in
// Flux's GitRepository; Branch with Commit limits the fetch to that branch,
// which must hold the commit.
type Ref struct {
	Branch string
	Tag    string
	Commit string
}

// Repo is a bare repository on disk that mirrors one remote: Fetch brings a
// ref in, Snapshot reads the layout at a commit. Snapshots stay readable
// after later fetches, since fetching only adds objects. Safe for concurrent
// use; fetches and reads take turns, as go-git's objects are not safe to
// share.
type Repo struct {
	mu   sync.Mutex
	dir  string
	opts RepoOptions
	repo *git.Repository
}

var (
	commitHex = regexp.MustCompile(`^[0-9a-f]{40}$`)
	scpLike   = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/]`)
)

// OpenRepo opens the bare repository in dir, or makes one when dir is
// missing or empty. A repository that mirrors another URL is refused.
func OpenRepo(dir string, o RepoOptions) (*Repo, error) {
	if err := checkURL(o); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// A file above MaxFileSize stays on disk instead of being read into
	// memory when it is looked at.
	st := filesystem.NewStorageWithOptions(osfs.New(dir), cache.NewObjectLRUDefault(),
		filesystem.Options{LargeObjectThreshold: MaxFileSize})
	r, err := git.Open(st, nil)
	if errors.Is(err, git.ErrRepositoryNotExists) {
		if r, err = git.Init(st, nil); err == nil {
			_, err = r.CreateRemote(&config.RemoteConfig{Name: "origin", URLs: []string{o.URL}})
		}
	}
	if err != nil {
		return nil, fmt.Errorf("git repository in %s: %w", dir, err)
	}
	remote, err := r.Remote("origin")
	if err != nil {
		return nil, fmt.Errorf("git repository in %s: %w", dir, err)
	}
	if urls := remote.Config().URLs; len(urls) != 1 || urls[0] != o.URL {
		return nil, fmt.Errorf("git repository in %s mirrors another URL", dir)
	}
	return &Repo{dir: dir, opts: o, repo: r}, nil
}

func checkURL(o RepoOptions) error {
	if o.URL == "" {
		return errors.New("git URL is empty")
	}
	if scpLike.MatchString(o.URL) {
		return nil
	}
	u, err := url.Parse(o.URL)
	if err != nil {
		return fmt.Errorf("git URL: %w", err)
	}
	if u.User != nil {
		if _, ok := u.User.Password(); ok || u.Scheme != "ssh" {
			return errors.New("git URL carries credentials; give them as Auth")
		}
	}
	switch {
	case u.Scheme == "https" || u.Scheme == "ssh":
		return nil
	case u.Scheme == "http" && o.AllowHTTP:
		return nil
	case (u.Scheme == "file" || u.Scheme == "") && o.AllowLocal:
		return nil
	}
	return fmt.Errorf("git URL scheme %q is not allowed", u.Scheme)
}

// Fetch brings ref in from the remote and returns the commit it names.
func (r *Repo) Fetch(ctx context.Context, ref Ref) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case ref.Commit != "":
		return r.fetchCommit(ctx, ref)
	case ref.Tag != "":
		name := plumbing.NewTagReferenceName(ref.Tag)
		if err := r.fetch(ctx, name, name, r.opts.Depth); err != nil {
			return "", err
		}
		return r.resolve(name)
	case ref.Branch != "":
		local := plumbing.NewRemoteReferenceName("origin", ref.Branch)
		if err := r.fetch(ctx, plumbing.NewBranchReferenceName(ref.Branch), local, r.opts.Depth); err != nil {
			return "", err
		}
		return r.resolve(local)
	}
	return "", errors.New("ref names no branch, tag or commit")
}

func (r *Repo) fetchCommit(ctx context.Context, ref Ref) (string, error) {
	if !commitHex.MatchString(ref.Commit) {
		return "", fmt.Errorf("commit %q is not a full SHA-1 in lower case", ref.Commit)
	}
	h := plumbing.NewHash(ref.Commit)
	// A shallow repository is asked to deepen all the way, as git fetch
	// --unshallow does; otherwise the server sends nothing for a tip it
	// already has, and the older commits stay missing.
	depth := 0
	if s, err := r.repo.Storer.Shallow(); err == nil && len(s) > 0 {
		depth = math.MaxInt32
	}
	if ref.Branch == "" {
		if _, err := r.repo.CommitObject(h); err == nil {
			return ref.Commit, nil
		}
		spec := config.RefSpec("+refs/heads/*:refs/remotes/origin/*")
		if err := r.fetchSpecs(ctx, []config.RefSpec{spec}, depth); err != nil {
			return "", err
		}
	} else {
		local := plumbing.NewRemoteReferenceName("origin", ref.Branch)
		if err := r.fetch(ctx, plumbing.NewBranchReferenceName(ref.Branch), local, depth); err != nil {
			return "", err
		}
		tip, err := r.resolve(local)
		if err != nil {
			return "", err
		}
		if ok, err := r.reaches(plumbing.NewHash(tip), h); err != nil || !ok {
			return "", errors.Join(fmt.Errorf("commit %s is not on branch %s", ref.Commit, ref.Branch), err)
		}
	}
	if _, err := r.repo.CommitObject(h); err != nil {
		return "", fmt.Errorf("commit %s: %w", ref.Commit, ErrNotFound)
	}
	return ref.Commit, nil
}

func (r *Repo) fetch(ctx context.Context, remote, local plumbing.ReferenceName, depth int) error {
	spec := config.RefSpec(fmt.Sprintf("+%s:%s", remote, local))
	return r.fetchSpecs(ctx, []config.RefSpec{spec}, depth)
}

func (r *Repo) fetchSpecs(ctx context.Context, specs []config.RefSpec, depth int) error {
	for _, s := range specs {
		if err := s.Validate(); err != nil {
			return err
		}
	}
	err := r.repo.FetchContext(ctx, &git.FetchOptions{
		RemoteName: "origin",
		RefSpecs:   specs,
		Depth:      depth,
		Auth:       r.opts.Auth,
		Tags:       git.NoTags,
		Force:      true,
	})
	switch {
	case err == nil, errors.Is(err, git.NoErrAlreadyUpToDate):
		return nil
	case errors.Is(err, git.NoMatchingRefSpecError{}):
		return fmt.Errorf("git fetch %s: %w", specs[0], ErrNotFound)
	}
	return fmt.Errorf("git fetch: %w", err)
}

// resolve gives the commit a local ref names, through annotated tags.
func (r *Repo) resolve(name plumbing.ReferenceName) (string, error) {
	ref, err := r.repo.Reference(name, true)
	if err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	h := ref.Hash()
	for range 10 {
		tag, err := r.repo.TagObject(h)
		if errors.Is(err, plumbing.ErrObjectNotFound) {
			break
		}
		if err != nil {
			return "", err
		}
		h = tag.Target
	}
	c, err := r.repo.CommitObject(h)
	if err != nil {
		return "", fmt.Errorf("%s does not name a commit: %w", name, err)
	}
	return c.Hash.String(), nil
}

// reaches reports whether want is tip or one of its ancestors.
func (r *Repo) reaches(tip, want plumbing.Hash) (bool, error) {
	c, err := r.repo.CommitObject(tip)
	if err != nil {
		return false, err
	}
	found := false
	err = object.NewCommitPreorderIter(c, nil, nil).ForEach(func(c *object.Commit) error {
		if c.Hash == want {
			found = true
			return errStop
		}
		return nil
	})
	if errors.Is(err, errStop) {
		err = nil
	}
	return found, err
}

var errStop = errors.New("stop")

// Snapshot reads the layout at commit, starting at dir in the repository
// ("" or "." for the top), as a source.FS whose Revision is the commit.
func (r *Repo) Snapshot(commit, dir string) (*FS, error) {
	if !commitHex.MatchString(commit) {
		return nil, fmt.Errorf("commit %q is not a full SHA-1 in lower case", commit)
	}
	dir = strings.Trim(dir, "/")
	if dir == "" {
		dir = "."
	}
	if !fs.ValidPath(dir) {
		return nil, fmt.Errorf("folder %q is not a clean relative path", dir)
	}
	r.mu.Lock()
	c, err := r.repo.CommitObject(plumbing.NewHash(commit))
	var root *object.Tree
	if err == nil {
		root, err = c.Tree()
	}
	r.mu.Unlock()
	if errors.Is(err, plumbing.ErrObjectNotFound) {
		return nil, fmt.Errorf("commit %s: %w", commit, ErrNotFound)
	}
	if err != nil {
		return nil, err
	}
	var fsys fs.FS = &treeFS{repo: r, root: root, when: c.Committer.When}
	if dir != "." {
		st, err := fs.Stat(fsys, dir)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%s at %s: %w", dir, commit, ErrNotFound)
		}
		if err != nil {
			return nil, err
		}
		if !st.IsDir() {
			return nil, fmt.Errorf("%s at %s is not a folder", path.Clean(dir), commit)
		}
		if fsys, err = fs.Sub(fsys, dir); err != nil {
			return nil, err
		}
	}
	return NewFS(fsys, commit), nil
}
