package main

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// until_time is the instant it names, sent in UTC as since_time is: auth-service compares it with a column that keeps
// UTC, so 05:01:52.5+09:00 goes as 20:01:52.5Z, for the audit log, AI usage and node logs alike.
func TestUntilTimeGoesAsUTC(t *testing.T) {
	const given, sent = "2026-11-18T05:01:52.5+09:00", "2026-11-17T20:01:52.5Z"

	seen := fakeAuthService(t, func(r *http.Request) (int, string) { return 200, `{"total":0,"items":[]}` })
	out, err := handleAuditSearch(ctxFor("c1"), map[string]interface{}{"since_time": "2026-11-18T04:58:51+09:00", "until_time": given}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	q := (*seen)[0].URL.Query()
	filter, _ := decode(t, out)["filter"].(map[string]interface{})
	if q.Get("since") != "2026-11-17T19:58:51Z" || q.Get("until") != sent || filter["until"] != sent {
		t.Errorf("audit_search: query %s, answer's filter %v", (*seen)[0].URL.RawQuery, filter)
	}

	seen = fakeAuthReplies(t, map[string]authReply{"/api/v1/auth/admin/ai-usage": {200, usageReply(), ""}})
	if _, err := handleAIUsage(ctxFor("c1"), map[string]interface{}{"until_time": given}, bearer()); err != nil {
		t.Fatal(err)
	}
	if got := (*seen)[0].URL.Query().Get("until"); got != sent {
		t.Errorf("ai_usage: until %q, want %q", got, sent)
	}

	calls := fakeKubectl(t, func([]string) (string, error) { return "Oct 16 01:00:00 n1 kubelet[812]: ready\n", nil })
	if _, err := handleNodesLog(ctxFor("c1"), map[string]interface{}{"node": "n1", "until_time": given}, bearer()); err != nil {
		t.Fatal(err)
	}
	if raw := verb((*calls)[0])[2]; !strings.Contains(raw, "untilTime="+url.QueryEscape(sent)) {
		t.Errorf("nodes_log: %s", raw)
	}
}

// An until_time that is not a time is a 400 before anything is asked, as a bad since_time is: one of the right shape
// (the argument check passes it) whose day does not exist, and a word.
func TestABadUntilTimeIsRefused(t *testing.T) {
	asked := 0
	fakeAuthService(t, func(r *http.Request) (int, string) { asked++; return 200, `{"total":0,"items":[]}` })
	calls := fakeKubectl(t, func([]string) (string, error) { return "", nil })
	for _, v := range []string{"2026-02-30T00:00:00Z", "tomorrow"} {
		args := map[string]interface{}{"node": "n1", "until_time": v}
		for name, call := range map[string]func() (string, error){
			"audit_search": func() (string, error) { return handleAuditSearch(ctxFor("c1"), args, bearer()) },
			"ai_usage":     func() (string, error) { return handleAIUsage(ctxFor("c1"), args, bearer()) },
			"nodes_log":    func() (string, error) { return handleNodesLog(ctxFor("c1"), args, bearer()) },
		} {
			if _, err := call(); !errors.Is(err, errBadRequest) || !strings.Contains(err.Error(), "until_time") {
				t.Errorf("%s with until_time %q: %v", name, v, err)
			}
		}
	}
	if asked != 0 || len(*calls) != 0 {
		t.Errorf("asked auth-service %d times and kubectl %d times", asked, len(*calls))
	}
}
