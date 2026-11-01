package promote

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/source"
)

// Request is one promotion.
type Request struct {
	Service, From, To string
	// Branch holds the environments; Base is the commit of it the change
	// starts from (fetched, so a push that finds it moved is a conflict).
	Branch string
	Base   string
	// PullRequest pushes to a new branch, kubeast/promote/<service>-<to>-
	// <commit>, for a pull request against Branch, instead of to Branch.
	PullRequest bool
	Author      source.Signature
	// Message is the commit message; empty: "deploy: promote <service>
	// from <from> to <to>" and the images.
	Message string
}

// Result is what a promotion did. Commit is empty when the next
// environment already had every image.
type Result struct {
	Commit  string
	Branch  string
	Images  map[string]string
	Changed []string
	Created bool
}

var nameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// Run reads the images from the earlier environment's file at Base, writes
// them into the next one's, commits and pushes. The remote branch is never
// overwritten: when it moved, source.ErrConflict.
func Run(ctx context.Context, repo *source.Repo, req Request) (Result, error) {
	for _, n := range []string{req.Service, req.From, req.To} {
		if len(n) > 63 || !nameRe.MatchString(n) {
			return Result{}, fmt.Errorf("%q is not a DNS label", n)
		}
	}
	if req.From == req.To {
		return Result{}, errors.New("promote to the same environment")
	}
	snap, err := repo.Snapshot(req.Base, "")
	if err != nil {
		return Result{}, err
	}
	from, err := snap.File(Path(req.Service, req.From))
	if err != nil {
		return Result{}, err
	}
	images, err := Images(from)
	if err != nil {
		return Result{}, fmt.Errorf("%s: %w", Path(req.Service, req.From), err)
	}
	if len(images) == 0 {
		return Result{}, fmt.Errorf("%s names no image to promote", Path(req.Service, req.From))
	}
	res := Result{Images: images}
	to, err := snap.File(Path(req.Service, req.To))
	switch {
	case errors.Is(err, source.ErrNotFound):
		res.Created = true
	case err != nil:
		return Result{}, err
	}
	out, changed, err := Apply(to, images)
	if err != nil {
		return Result{}, fmt.Errorf("%s: %w", Path(req.Service, req.To), err)
	}
	if len(changed) == 0 {
		return res, nil
	}
	res.Changed = changed
	msg := req.Message
	if msg == "" {
		msg = defaultMessage(req, images)
	}
	if res.Commit, err = repo.Commit(ctx, req.Base, map[string][]byte{Path(req.Service, req.To): out}, req.Author, msg); err != nil {
		return Result{}, err
	}
	res.Branch = req.Branch
	if req.PullRequest {
		res.Branch = "kubeast/promote/" + req.Service + "-" + req.To + "-" + res.Commit[:12]
	}
	if err := repo.Push(ctx, res.Commit, res.Branch); err != nil {
		return Result{}, err
	}
	return res, nil
}

func defaultMessage(req Request, images map[string]string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "deploy: promote %s from %s to %s\n\n", req.Service, req.From, req.To)
	names := make([]string, 0, len(images))
	for n := range images {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(&b, "%s: %s\n", n, images[n])
	}
	return b.String()
}
