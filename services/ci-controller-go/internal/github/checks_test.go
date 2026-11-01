package github

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// TestCheckRunLifecycle: a build's run is created queued, moves to in
// progress, and completes with its conclusion and output — the bodies
// GitHub's REST reference accepts.
func TestCheckRunLifecycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	start := e.now
	id, err := e.client.CreateCheckRun(ctx, "acme/web", CheckRun{
		Name: "kubeast / build", HeadSHA: sha1, ExternalID: "b1",
		DetailsURL: "https://kubeast.example.com/ci/builds/b1", Status: StatusQueued,
		Title: "Waiting", Summary: "3rd in line",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.client.UpdateCheckRun(ctx, "acme/web", id, CheckRun{Status: StatusInProgress, StartedAt: start, Title: "Running", Summary: "step test"}); err != nil {
		t.Fatal(err)
	}
	e.now = e.now.Add(4 * time.Minute)
	if err := e.client.UpdateCheckRun(ctx, "acme/web", id, CheckRun{Status: StatusCompleted, Conclusion: "success", Title: "Passed", Summary: "4 steps in 4m0s"}); err != nil {
		t.Fatal(err)
	}
	run := e.gh.checkRuns[id]
	want := map[string]any{
		"name": "kubeast / build", "head_sha": sha1, "external_id": "b1", "details_url": "https://kubeast.example.com/ci/builds/b1",
		"status": "completed", "conclusion": "success", "started_at": "2026-11-01T07:00:00Z", "completed_at": "2026-11-01T07:04:00Z",
	}
	for k, v := range want {
		if run[k] != v {
			t.Errorf("%s = %v, want %v", k, run[k], v)
		}
	}
	if out := run["output"].(map[string]any); out["title"] != "Passed" || out["summary"] != "4 steps in 4m0s" {
		t.Errorf("output %v", out)
	}
	// The first body named the run; the updates do not resend name or commit.
	if _, ok := e.gh.checkBodies[1]["name"]; ok {
		t.Error("an update sent the name")
	}
	if _, ok := e.gh.checkBodies[0]["conclusion"]; ok {
		t.Error("a queued run sent a conclusion")
	}
}

func TestCheckRunRefusedLocally(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ok := CheckRun{Name: "kubeast / build", HeadSHA: sha1, Status: StatusQueued}
	cases := map[string]CheckRun{
		"short commit":                 {Name: ok.Name, HeadSHA: "abc", Status: StatusQueued},
		"no name":                      {HeadSHA: sha1, Status: StatusQueued},
		"control character in a name":  {Name: "a\nb", HeadSHA: sha1, Status: StatusQueued},
		"completed without conclusion": {Name: ok.Name, HeadSHA: sha1, Status: StatusCompleted},
		"unknown conclusion":           {Name: ok.Name, HeadSHA: sha1, Status: StatusCompleted, Conclusion: "stale"},
		"Actions-only status":          {Name: ok.Name, HeadSHA: sha1, Status: "waiting"},
		"queued with a conclusion":     {Name: ok.Name, HeadSHA: sha1, Status: StatusQueued, Conclusion: "success"},
		"summary without a title":      {Name: ok.Name, HeadSHA: sha1, Status: StatusQueued, Summary: "x"},
	}
	for name, r := range cases {
		if _, err := e.client.CreateCheckRun(ctx, "acme/web", r); err == nil {
			t.Errorf("%s: created", name)
		}
	}
	if _, err := e.client.CreateCheckRun(ctx, "not a repo", ok); err == nil {
		t.Error("bad repository name sent")
	}
	if err := e.client.UpdateCheckRun(ctx, "acme/web", 0, CheckRun{Status: StatusInProgress}); err == nil {
		t.Error("update without an ID sent")
	}
	if len(e.gh.checkBodies) != 0 {
		t.Errorf("%d refused bodies reached GitHub", len(e.gh.checkBodies))
	}
}

func TestCheckRunOutputCutAtGitHubsLimit(t *testing.T) {
	e := newEnv(t)
	long := strings.Repeat("로그", 40_000) // 80,000 characters, 240,000 bytes
	_, err := e.client.CreateCheckRun(context.Background(), "acme/web", CheckRun{
		Name: "kubeast / build", HeadSHA: sha1, Status: StatusQueued, Title: "Failed", Summary: long, Text: long,
	})
	if err != nil {
		t.Fatalf("GitHub refused the cut output: %v", err)
	}
	out := e.gh.checkBodies[0]["output"].(map[string]any)
	for _, k := range []string{"summary", "text"} {
		s := out[k].(string)
		if len(s) > MaxCheckText || !utf8.ValidString(s) || !strings.HasSuffix(s, cutNote) {
			t.Errorf("%s: %d bytes, valid %v, ends with the note %v", k, len(s), utf8.ValidString(s), strings.HasSuffix(s, cutNote))
		}
	}
	if got := cut("short"); got != "short" {
		t.Errorf("a short text was cut: %q", got)
	}
}

func TestCheckRunRefusals(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.app.InstallationToken(ctx, installation); err != nil {
		t.Fatal(err)
	}
	e.gh.fail = []failure{{status: 403, message: "Resource not accessible by integration"}}
	_, err := e.client.CreateCheckRun(ctx, "acme/web", CheckRun{Name: "kubeast / build", HeadSHA: sha1, Status: StatusQueued})
	var api *APIError
	if !errors.As(err, &api) || api.Status != 403 || !strings.Contains(err.Error(), "Resource not accessible") || strings.Contains(err.Error(), "ghs_") {
		t.Fatalf("a missing Checks permission: %v", err)
	}
	// A token GitHub forgot is replaced once.
	e.gh.mu.Lock()
	e.gh.tokens = map[string]int64{}
	e.gh.mu.Unlock()
	if _, err := e.client.CreateCheckRun(ctx, "acme/web", CheckRun{Name: "kubeast / build", HeadSHA: sha1, Status: StatusQueued}); err != nil {
		t.Fatalf("after a 401: %v", err)
	}
	if err := e.client.UpdateCheckRun(ctx, "acme/web", 9999, CheckRun{Status: StatusInProgress}); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("unknown run: %v", err)
	}
}

func TestConclusion(t *testing.T) {
	want := map[string]string{
		OutcomeSucceeded: "success", OutcomeFailed: "failure", OutcomeCancelled: "cancelled",
		OutcomeTimedOut: "timed_out", OutcomeReplaced: "skipped", OutcomeNeedsOK: "action_required",
	}
	for outcome, c := range want {
		got, ok := Conclusion(outcome)
		if !ok || got != c || !conclusions[got] {
			t.Errorf("%s: %q %v, want %q", outcome, got, ok, c)
		}
	}
	if _, ok := Conclusion("exploded"); ok {
		t.Error("an unknown outcome maps")
	}
}
