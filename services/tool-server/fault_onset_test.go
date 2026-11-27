package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// The two tools' answers as k8s-service gives them, and what each tool asks k8s-service, with AI_FAULT_ONSET off and on.
func onsetAnswers(t *testing.T, value string) (map[string]string, map[string]string) {
	t.Helper()
	t.Setenv("AI_FAULT_ONSET", value)
	since := func(r *http.Request, extra string) string {
		if r.URL.Query().Get("with_since") == "true" {
			return extra
		}
		return ""
	}
	answers, asked := map[string]string{}, map[string]string{}
	for tool, handler := range map[string]func(context.Context, map[string]interface{}, http.Header) (string, error){"issues": handleIssues, "anomaly_rank": handleAnomalyRank} {
		seen := fakeK8sService(t, func(r *http.Request) (int, string) {
			if strings.HasSuffix(r.URL.Path, "/anomalies") {
				return 200, anomalyReply([]string{`{"check":"issues","target":"Pod/web-1","verdict":"anomalous","summary":"critical now"` + since(r, `,"since":"2026-11-14T22:00:00Z","already_there":true,"worse":true`) + `}`})
			}
			return 200, `{` + issuesWindow + `,"issues":[{"id":"Pod/shop/web-1","kind":"Pod","name":"web-1","namespace":"shop","reason":"CrashLoopBackOff","severity":"critical"` + since(r, `,"since":"2026-10-14T23:00:00Z"`) + `}]}`
		})
		out, err := handler(ctxFor("c1"), map[string]interface{}{"namespace": "shop"}, bearer())
		if err != nil {
			t.Fatal(err)
		}
		if len(*seen) != 1 {
			t.Fatalf("%s asked %d times", tool, len(*seen))
		}
		answers[tool], asked[tool] = out, (*seen)[0].URL.Path+"?"+(*seen)[0].URL.RawQuery
	}
	return answers, asked
}

func TestFaultOnset_OffNothingIsAskedAndTheAnswersAreAsBefore(t *testing.T) {
	want, asked := onsetAnswers(t, "")
	if strings.Contains(asked["issues"]+asked["anomaly_rank"], "with_since") {
		t.Fatalf("asked %v", asked)
	}
	for tool, out := range want {
		if strings.Contains(out, "since") || strings.Contains(out, "already_there") {
			t.Errorf("%s: %s", tool, out)
		}
	}
	for _, value := range []string{"false", "0", "no", "t"} {
		got, gotAsked := onsetAnswers(t, value)
		for tool := range want {
			if got[tool] != want[tool] || gotAsked[tool] != asked[tool] {
				t.Errorf("%q %s: %s asked %s", value, tool, got[tool], gotAsked[tool])
			}
		}
	}
}

func TestFaultOnset_OnBothToolsAskForSinceAndPassItOn(t *testing.T) {
	off, offAsked := onsetAnswers(t, "")
	for _, value := range []string{"true", "TRUE", "1", "on", " yes "} {
		on, asked := onsetAnswers(t, value)
		for tool := range off {
			if got := strings.Replace(strings.Replace(asked[tool], "&with_since=true", "", 1), "with_since=true", "", 1); got != offAsked[tool] || got == asked[tool] {
				t.Errorf("%q %s asked %s, off %s", value, tool, asked[tool], offAsked[tool])
			}
		}
		issue := decode(t, on["issues"])["issues"].([]interface{})[0].(map[string]interface{})
		if issue["since"] != "2026-10-14T23:00:00Z" {
			t.Errorf("%q: %s", value, on["issues"])
		}
		finding := decode(t, on["anomaly_rank"])["findings"].([]interface{})[0].(map[string]interface{})
		if finding["since"] != "2026-11-14T22:00:00Z" || finding["already_there"] != true || finding["worse"] != true {
			t.Errorf("%q: %s", value, on["anomaly_rank"])
		}
	}
}
