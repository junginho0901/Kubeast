package source

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/filemode"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// ErrConflict: the branch moved on the remote since the commit's parent,
// and a push never overwrites; fetch again and redo the change.
var ErrConflict = errors.New("the branch moved on the remote")

// Signature names a commit's author, who is also its committer.
type Signature struct {
	Name  string
	Email string
	When  time.Time
}

// Commit makes a commit on top of base that sets the given files (paths
// in the layout, whole contents) and changes nothing else, from git's
// objects without a checkout, and returns it. Nothing is pushed.
func (r *Repo) Commit(ctx context.Context, base string, files map[string][]byte, who Signature, message string) (string, error) {
	if !commitHex.MatchString(base) {
		return "", fmt.Errorf("commit %q is not a full SHA-1 in lower case", base)
	}
	if len(files) == 0 {
		return "", errors.New("no files to commit")
	}
	if who.Name == "" || !strings.Contains(who.Email, "@") {
		return "", errors.New("a commit needs an author name and email")
	}
	if strings.TrimSpace(message) == "" {
		return "", errors.New("a commit needs a message")
	}
	for p := range files {
		if !fs.ValidPath(p) || p == "." || strings.HasPrefix(p, ".git/") || p == ".git" {
			return "", fmt.Errorf("path %q is not a clean file path in the layout", p)
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	parent, err := r.repo.CommitObject(plumbing.NewHash(base))
	if err != nil {
		return "", fmt.Errorf("commit %s: %w", base, ErrNotFound)
	}
	tree, err := parent.Tree()
	if err != nil {
		return "", err
	}
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	treeHash := tree.Hash
	for _, p := range paths {
		if treeHash, err = r.setFile(treeHash, strings.Split(p, "/"), files[p]); err != nil {
			return "", fmt.Errorf("%s: %w", p, err)
		}
	}
	if treeHash == tree.Hash {
		return "", errors.New("the files are already as given")
	}
	when := who.When
	if when.IsZero() {
		when = time.Now()
	}
	sig := object.Signature{Name: who.Name, Email: who.Email, When: when}
	c := &object.Commit{Author: sig, Committer: sig, Message: message, TreeHash: treeHash, ParentHashes: []plumbing.Hash{parent.Hash}}
	h, err := r.store(c)
	if err != nil {
		return "", err
	}
	return h.String(), nil
}

// setFile writes data at path under the tree h and returns the new tree,
// making the folders on the way; a link or submodule on the way is an
// error, as reading never follows them.
func (r *Repo) setFile(h plumbing.Hash, path []string, data []byte) (plumbing.Hash, error) {
	var entries []object.TreeEntry
	if !h.IsZero() {
		t, err := r.repo.TreeObject(h)
		if err != nil {
			return plumbing.ZeroHash, err
		}
		entries = append(entries, t.Entries...)
	}
	name := path[0]
	i := -1
	for j, e := range entries {
		if e.Name == name {
			i = j
		}
	}
	var entry object.TreeEntry
	if len(path) == 1 {
		if i >= 0 && entries[i].Mode != filemode.Regular && entries[i].Mode != filemode.Executable && entries[i].Mode != filemode.Deprecated {
			return plumbing.ZeroHash, fmt.Errorf("%s is not a file", name)
		}
		blob := r.repo.Storer.NewEncodedObject()
		blob.SetType(plumbing.BlobObject)
		w, err := blob.Writer()
		if err != nil {
			return plumbing.ZeroHash, err
		}
		if _, err := w.Write(data); err != nil {
			return plumbing.ZeroHash, err
		}
		if err := w.Close(); err != nil {
			return plumbing.ZeroHash, err
		}
		bh, err := r.repo.Storer.SetEncodedObject(blob)
		if err != nil {
			return plumbing.ZeroHash, err
		}
		mode := filemode.Regular
		if i >= 0 {
			mode = entries[i].Mode // an executable stays one
		}
		entry = object.TreeEntry{Name: name, Mode: mode, Hash: bh}
	} else {
		sub := plumbing.ZeroHash
		if i >= 0 {
			if entries[i].Mode != filemode.Dir {
				return plumbing.ZeroHash, fmt.Errorf("%s is not a folder", name)
			}
			sub = entries[i].Hash
		}
		nh, err := r.setFile(sub, path[1:], data)
		if err != nil {
			return plumbing.ZeroHash, err
		}
		entry = object.TreeEntry{Name: name, Mode: filemode.Dir, Hash: nh}
	}
	if i >= 0 {
		entries[i] = entry
	} else {
		entries = append(entries, entry)
	}
	sort.Sort(object.TreeEntrySorter(entries))
	return r.store(&object.Tree{Entries: entries})
}

type encoder interface {
	Encode(plumbing.EncodedObject) error
}

func (r *Repo) store(o encoder) (plumbing.Hash, error) {
	obj := r.repo.Storer.NewEncodedObject()
	if err := o.Encode(obj); err != nil {
		return plumbing.ZeroHash, err
	}
	return r.repo.Storer.SetEncodedObject(obj)
}

// Push sends commit to branch on the remote, only as a fast-forward: when
// the branch moved since, ErrConflict, and the remote is unchanged. A new
// branch is created.
func (r *Repo) Push(ctx context.Context, commit, branch string) error {
	if !commitHex.MatchString(commit) {
		return fmt.Errorf("commit %q is not a full SHA-1 in lower case", commit)
	}
	// A name, not a ref: "refs/heads/x" would push to refs/heads/refs/heads/x.
	if err := plumbing.NewBranchReferenceName(branch).Validate(); err != nil || strings.Contains(branch, "..") || strings.HasPrefix(branch, "refs/") {
		return fmt.Errorf("branch %q is not a valid branch name", branch)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	h := plumbing.NewHash(commit)
	if _, err := r.repo.CommitObject(h); err != nil {
		return fmt.Errorf("commit %s: %w", commit, ErrNotFound)
	}
	var tag [8]byte
	rand.Read(tag[:])
	tmp := plumbing.ReferenceName("refs/kubeast/push/" + hex.EncodeToString(tag[:]))
	if err := r.repo.Storer.SetReference(plumbing.NewHashReference(tmp, h)); err != nil {
		return err
	}
	defer r.repo.Storer.RemoveReference(tmp)
	err := r.repo.PushContext(ctx, &git.PushOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{config.RefSpec(fmt.Sprintf("%s:refs/heads/%s", tmp, branch))},
		Auth:       r.opts.Auth,
	})
	switch {
	case err == nil, errors.Is(err, git.NoErrAlreadyUpToDate):
	case strings.Contains(err.Error(), "non-fast-forward"), strings.Contains(err.Error(), "fetch first"), strings.Contains(err.Error(), "rejected"):
		return fmt.Errorf("push %s: %w", branch, ErrConflict)
	default:
		return fmt.Errorf("git push: %w", err)
	}
	return r.repo.Storer.SetReference(plumbing.NewHashReference(plumbing.NewRemoteReferenceName("origin", branch), h))
}
