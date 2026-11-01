// Package signals turns what polling finds into the events a webhook would
// have sent (design ⓒ §9: polling is the fallback that always runs), so the
// rest of the controller handles both the same way.
package signals

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/github"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/webhook"
)

// Seen is what polling last saw of one repository. The caller keeps it (in
// the database, after stage 0) and hands it back on the next poll; it is
// plain JSON for that.
type Seen struct {
	Branches     map[string]string `json:"branches"`
	Tags         map[string]string `json:"tags"`
	PullRequests map[int]string    `json:"pullRequests"` // number → head commit
}

// FromPoll turns what a poll found into the events a webhook would have
// sent for the same changes, so polled and pushed repositories build the
// same way: a branch or tag that is new or points elsewhere is a push, a
// pull request that is new is opened and one whose head moved is
// synchronize. Deleted branches and closed pull requests give nothing, as
// their webhooks do.
//
// prev nil is the first poll of the repository: everything is recorded and
// nothing builds, as installing a webhook builds nothing that is already
// there. An archived or missing repository changes nothing. A truncated
// answer (more than github.MaxPages pages) keeps what it could not list.
//
// Polling sees the newest github.HeadsTags tags only, so more tags pushed
// at once than that reach Kubeast through the webhook alone; a tag that
// falls out of that window is forgotten and would build again if it came
// back, which happens only when newer tags are deleted.
func FromPoll(prev *Seen, h github.RepoHeads, installation int64) ([]webhook.Event, *Seen) {
	if h.Archived || h.Missing {
		return nil, prev
	}
	now := &Seen{Branches: copyRefs(h.Branches), Tags: copyRefs(h.Tags), PullRequests: map[int]string{}}
	for _, pr := range h.PullRequests {
		now.PullRequests[pr.Number] = pr.HeadSHA
	}
	if prev == nil {
		return nil, now
	}
	if h.Truncated {
		for name, sha := range prev.Branches {
			if _, ok := now.Branches[name]; !ok {
				now.Branches[name] = sha
			}
		}
		for n, sha := range prev.PullRequests {
			if _, ok := now.PullRequests[n]; !ok {
				now.PullRequests[n] = sha
			}
		}
	}
	base := webhook.Event{Installation: installation, RepoID: h.RepoID, Repo: h.Repo}
	var out []webhook.Event
	push := func(ref, sha string) {
		e := base
		e.Kind, e.Ref, e.SHA = webhook.KindPush, ref, sha
		e.Delivery = delivery(h.RepoID, ref, sha)
		out = append(out, e)
	}
	for _, name := range sortedKeys(h.Branches) {
		if sha := h.Branches[name]; prev.Branches[name] != sha {
			push("refs/heads/"+name, sha)
		}
	}
	for _, name := range sortedKeys(h.Tags) {
		if sha := h.Tags[name]; prev.Tags[name] != sha {
			push("refs/tags/"+name, sha)
		}
	}
	prs := append([]github.PullRequest(nil), h.PullRequests...)
	sort.Slice(prs, func(i, j int) bool { return prs[i].Number < prs[j].Number })
	for _, pr := range prs {
		old, seen := prev.PullRequests[pr.Number]
		if seen && old == pr.HeadSHA {
			continue
		}
		e := base
		e.Kind, e.Action = webhook.KindPullRequest, "opened"
		if seen {
			e.Action = "synchronize"
		}
		e.Number, e.SHA, e.Fork = pr.Number, pr.HeadSHA, pr.Fork
		e.Ref = "refs/heads/" + pr.Base
		e.HeadRef = "refs/pull/" + strconv.Itoa(pr.Number) + "/head"
		e.Delivery = delivery(h.RepoID, e.HeadRef, pr.HeadSHA)
		out = append(out, e)
	}
	return out, now
}

// delivery names a polled change the same way every time it is seen, so a
// change found twice is one delivery (webhook.Deliveries keeps IDs a day).
func delivery(repoID int64, ref, sha string) string {
	sum := sha256.Sum256(fmt.Appendf(nil, "%d\x00%s\x00%s", repoID, ref, sha))
	return "poll-" + hex.EncodeToString(sum[:16])
}

func copyRefs(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
