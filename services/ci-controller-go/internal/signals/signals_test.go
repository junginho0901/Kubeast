package signals

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/github"
	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/webhook"
)

func sha(c string) string { return strings.Repeat(c, 40) }

func heads(branches, tags map[string]string, prs ...github.PullRequest) github.RepoHeads {
	return github.RepoHeads{Repo: "acme/web", RepoID: 42, Branches: branches, Tags: tags, PullRequests: prs}
}

func TestFirstPollBuildsNothing(t *testing.T) {
	ev, seen := FromPoll(nil, heads(map[string]string{"main": sha("a")}, map[string]string{"v1": sha("b")}, github.PullRequest{Number: 3, HeadSHA: sha("c"), Base: "main"}), 7)
	if len(ev) != 0 {
		t.Fatalf("first poll gave %+v", ev)
	}
	want := &Seen{Branches: map[string]string{"main": sha("a")}, Tags: map[string]string{"v1": sha("b")}, PullRequests: map[int]string{3: sha("c")}}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("seen %+v", seen)
	}
	if ev, _ := FromPoll(seen, heads(map[string]string{"main": sha("a")}, map[string]string{"v1": sha("b")}, github.PullRequest{Number: 3, HeadSHA: sha("c"), Base: "main"}), 7); len(ev) != 0 {
		t.Fatalf("no change gave %+v", ev)
	}
}

func TestChanges(t *testing.T) {
	prev := &Seen{
		Branches:     map[string]string{"main": sha("a"), "old": sha("b"), "same": sha("c")},
		Tags:         map[string]string{"v1": sha("d"), "moved": sha("e")},
		PullRequests: map[int]string{1: sha("f"), 2: sha("1"), 9: sha("2")},
	}
	now := heads(
		map[string]string{"main": sha("3"), "same": sha("c"), "feature/x": sha("4")}, // main moved, old deleted, feature new
		map[string]string{"v1": sha("d"), "moved": sha("5"), "v2": sha("6")},
		github.PullRequest{Number: 1, HeadSHA: sha("7"), Base: "main"},            // pushed to
		github.PullRequest{Number: 2, HeadSHA: sha("1"), Base: "main"},            // unchanged
		github.PullRequest{Number: 5, HeadSHA: sha("8"), Base: "dev", Fork: true}, // opened from a fork
	) // 9 closed
	ev, seen := FromPoll(prev, now, 7)
	var got []string
	for _, e := range ev {
		got = append(got, e.Kind+" "+e.Action+" "+e.Ref+" "+e.HeadRef+" "+e.SHA[:1])
	}
	want := []string{
		"push  refs/heads/feature/x  4",
		"push  refs/heads/main  3",
		"push  refs/tags/moved  5",
		"push  refs/tags/v2  6",
		"pull_request synchronize refs/heads/main refs/pull/1/head 7",
		"pull_request opened refs/heads/dev refs/pull/5/head 8",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if !ev[5].Fork || ev[4].Fork || ev[0].Installation != 7 || ev[0].RepoID != 42 || ev[0].Repo != "acme/web" {
		t.Errorf("fork, installation or repository: %+v", ev)
	}
	if _, ok := seen.Branches["old"]; ok || seen.PullRequests[9] != "" || seen.Branches["main"] != sha("3") {
		t.Errorf("seen %+v", seen)
	}
}

func TestArchivedMissingAndTruncated(t *testing.T) {
	prev := &Seen{Branches: map[string]string{"main": sha("a"), "far": sha("b")}, Tags: map[string]string{}, PullRequests: map[int]string{4: sha("c")}}
	for _, h := range []github.RepoHeads{
		{Repo: "acme/web", RepoID: 42, Archived: true, Branches: map[string]string{"main": sha("9")}},
		{Repo: "acme/web", RepoID: 42, Missing: true},
	} {
		if ev, seen := FromPoll(prev, h, 7); len(ev) != 0 || seen != prev {
			t.Errorf("%+v: events %+v, seen changed", h, ev)
		}
	}
	h := heads(map[string]string{"main": sha("a")}, nil)
	h.Truncated = true
	ev, seen := FromPoll(prev, h, 7)
	if len(ev) != 0 || seen.Branches["far"] != sha("b") || seen.PullRequests[4] != sha("c") {
		t.Fatalf("truncated: events %+v seen %+v", ev, seen)
	}
	// The branch shows up on a later full answer, unchanged: nothing builds.
	if ev, _ := FromPoll(seen, heads(map[string]string{"main": sha("a"), "far": sha("b")}, nil, github.PullRequest{Number: 4, HeadSHA: sha("c"), Base: "main"}), 7); len(ev) != 0 {
		t.Fatalf("a branch kept through a truncated answer built: %+v", ev)
	}
}

var deliveryRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`) // as webhook.Check takes them

func TestDeliveryIDs(t *testing.T) {
	prev := &Seen{Branches: map[string]string{}, Tags: map[string]string{}, PullRequests: map[int]string{}}
	h := heads(map[string]string{"main": sha("a"), "dev": sha("a")}, nil, github.PullRequest{Number: 1, HeadSHA: sha("a"), Base: "main"})
	ev1, _ := FromPoll(prev, h, 7)
	ev2, _ := FromPoll(prev, h, 7)
	ids := map[string]bool{}
	for i, e := range ev1 {
		if !deliveryRe.MatchString(e.Delivery) || e.Delivery != ev2[i].Delivery {
			t.Errorf("delivery %q (again %q)", e.Delivery, ev2[i].Delivery)
		}
		ids[e.Delivery] = true
	}
	if len(ids) != 3 {
		t.Errorf("same commit on three refs gave %d delivery IDs", len(ids))
	}
}

func TestSeenRoundTripsJSON(t *testing.T) {
	_, seen := FromPoll(nil, heads(map[string]string{"main": sha("a")}, map[string]string{"v1": sha("b")}, github.PullRequest{Number: 12, HeadSHA: sha("c"), Base: "main"}), 7)
	b, err := json.Marshal(seen)
	if err != nil {
		t.Fatal(err)
	}
	var back Seen
	if err := json.Unmarshal(b, &back); err != nil || !reflect.DeepEqual(&back, seen) {
		t.Fatalf("%s → %+v %v", b, back, err)
	}
}

// TestSameAsWebhook: each polled event equals what webhook.Check makes of
// the payload GitHub would send for the same change (delivery and sender
// aside), so the rest of the controller cannot tell them apart.
func TestSameAsWebhook(t *testing.T) {
	secret := []byte("kubeast-test-webhook-secret-0123456789")
	v, err := webhook.NewVerifier(secret)
	if err != nil {
		t.Fatal(err)
	}
	check := func(event string, payload map[string]any) webhook.Event {
		t.Helper()
		body, _ := json.Marshal(payload)
		mac := hmac.New(sha256.New, secret)
		mac.Write(body)
		r := v.Check(event, "d-1", "sha256="+hex.EncodeToString(mac.Sum(nil)), body)
		if r.Outcome != webhook.Accepted {
			t.Fatalf("%s %s: %+v", event, body, r)
		}
		return r.Event
	}
	repo := map[string]any{"id": 42, "full_name": "acme/web"}
	inst := map[string]any{"id": 7}
	prev := &Seen{Branches: map[string]string{"main": sha("a")}, Tags: map[string]string{}, PullRequests: map[int]string{1: sha("b")}}
	ev, _ := FromPoll(prev, heads(map[string]string{"main": sha("c")}, map[string]string{"v1.0.0": sha("d")},
		github.PullRequest{Number: 1, HeadSHA: sha("e"), Base: "main"},
		github.PullRequest{Number: 2, HeadSHA: sha("f"), Base: "main", Fork: true}), 7)
	want := []webhook.Event{
		check("push", map[string]any{"ref": "refs/heads/main", "after": sha("c"), "repository": repo, "installation": inst}),
		check("push", map[string]any{"ref": "refs/tags/v1.0.0", "after": sha("d"), "repository": repo, "installation": inst}),
		check("pull_request", map[string]any{"action": "synchronize", "number": 1, "repository": repo, "installation": inst,
			"pull_request": map[string]any{"head": map[string]any{"sha": sha("e"), "repo": repo}, "base": map[string]any{"ref": "main", "repo": repo}}}),
		check("pull_request", map[string]any{"action": "opened", "number": 2, "repository": repo, "installation": inst,
			"pull_request": map[string]any{"head": map[string]any{"sha": sha("f"), "repo": map[string]any{"id": 99, "full_name": "someone/web"}}, "base": map[string]any{"ref": "main", "repo": repo}}}),
	}
	if len(ev) != len(want) {
		t.Fatalf("%d events, want %d: %+v", len(ev), len(want), ev)
	}
	for i := range ev {
		got := ev[i]
		got.Delivery, want[i].Delivery = "", ""
		if got != want[i] {
			t.Errorf("event %d:\n polled  %+v\n webhook %+v", i, got, want[i])
		}
	}
}
