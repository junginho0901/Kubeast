package webhook

import (
	"encoding/json"
	"testing"
)

// edit rewrites a field of a payload file: path names nested keys.
func edit(t *testing.T, name string, value any, path ...string) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(payload(t, name), &m); err != nil {
		t.Fatal(err)
	}
	cur := m
	for _, k := range path[:len(path)-1] {
		cur = cur[k].(map[string]any)
	}
	if value == nil {
		delete(cur, path[len(path)-1])
	} else {
		cur[path[len(path)-1]] = value
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRerunRequests(t *testing.T) {
	v := verifier(t)
	check := func(event string, body []byte) Result {
		return v.Check(event, delivery, sign(testSecret, body), body)
	}

	// octokit's example check run has no external_id: not a run Kubeast made.
	if r := check("check_run", payload(t, "check_run_rerequested.payload.json")); r.Outcome != Ignored || r.Reason != "external-id" {
		t.Errorf("check run without external_id = %+v", r)
	}
	r := check("check_run", edit(t, "check_run_rerequested.payload.json", "b-0001", "check_run", "external_id"))
	want := Event{Delivery: delivery, Kind: "check_run", Action: "rerequested", Installation: 1, RepoID: 526, Repo: "github/hello-world",
		Ref: "refs/heads/master", SHA: "d6fde92930d4715a2b49857d24b940956b26d2d3", Sender: "octocat",
		CheckRunID: 4, CheckSuiteID: 5, App: 2, Build: "b-0001"}
	if r.Outcome != Accepted || r.Event != want {
		t.Errorf("check run rerun = %+v\nwant %+v", r, want)
	}

	r = check("check_suite", payload(t, "check_suite_rerequested.payload.json"))
	want = Event{Delivery: delivery, Kind: "check_suite", Action: "rerequested", Installation: 957387, RepoID: 186853002, Repo: "Codertocat/Hello-World",
		Ref: "refs/heads/changes", SHA: "ec26c3e57ca3a959ca5aad62de7213c562f8c821", Number: 2, Sender: "octocoders-linter[bot]",
		CheckSuiteID: 118578147, App: 29310}
	if r.Outcome != Accepted || r.Event != want {
		t.Errorf("check suite rerun = %+v\nwant %+v", r, want)
	}

	// A suite of a tag push or a fork's pull request has no branch here.
	if r := check("check_suite", edit(t, "check_suite_rerequested.payload.json", nil, "check_suite", "head_branch")); r.Outcome != Accepted || r.Event.Ref != "" {
		t.Errorf("suite without a branch = %+v", r)
	}

	for name, tc := range map[string]struct {
		event  string
		body   []byte
		result Outcome
		reason string
	}{
		"requested_action": {"check_run", payload(t, "check_run_requested_action.payload.json"), Ignored, "action"},
		"completed":        {"check_suite", edit(t, "check_suite_rerequested.payload.json", "completed", "action"), Ignored, "action"},
		"external_id path": {"check_run", edit(t, "check_run_rerequested.payload.json", "../b1", "check_run", "external_id"), Ignored, "external-id"},
		"external_id case": {"check_run", edit(t, "check_run_rerequested.payload.json", "B1", "check_run", "external_id"), Ignored, "external-id"},
		"no app":           {"check_suite", edit(t, "check_suite_rerequested.payload.json", nil, "check_suite", "app"), Rejected, "malformed"},
		"app id 0":         {"check_suite", edit(t, "check_suite_rerequested.payload.json", map[string]any{"id": 0}, "check_suite", "app"), Rejected, "malformed"},
		"short sha":        {"check_suite", edit(t, "check_suite_rerequested.payload.json", "ec26c3e", "check_suite", "head_sha"), Rejected, "malformed"},
		"no check run":     {"check_run", edit(t, "check_run_rerequested.payload.json", nil, "check_run"), Rejected, "malformed"},
		"branch spaces":    {"check_suite", edit(t, "check_suite_rerequested.payload.json", "a b", "check_suite", "head_branch"), Rejected, "malformed"},
		"no repository":    {"check_suite", edit(t, "check_suite_rerequested.payload.json", nil, "repository"), Rejected, "malformed"},
	} {
		if r := check(tc.event, tc.body); r.Outcome != tc.result || r.Reason != tc.reason {
			t.Errorf("%s = %+v, want %v %s", name, r, tc.result, tc.reason)
		}
	}
}
