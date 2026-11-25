package main

import (
	"net/http"
	"strings"
	"testing"
)

// changesAnswer is what the model reads of the changes view when k8s-service answers with this summary and changes.
func changesAnswer(t *testing.T, a args, summary, changes string) (map[string]interface{}, string) {
	t.Helper()
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, `{"changes":` + changes + `,"summary":` + summary + `}` })
	a["view"] = "changes"
	out, err := handleTimeline(ctxFor("c1"), a, bearer())
	if err != nil {
		t.Fatal(err)
	}
	return decode(t, out), out
}

const (
	offNothing = `{"by_source":{"rollouts":0},"changes_shown":0,"changes_total":0}`
	offHint    = "Nothing changed in this window as far as the objects keep it. Each ConfigMap, Secret, HPA and container keeps only its last change; older ones are in events, which live about an hour."
	offCut     = "The newest 1 of the 70 changes in this window are listed; summary.by_source counts them by source."
	oneChange  = `[{"when":"2026-11-25T09:00:00Z","kind":"ConfigMap","name":"cfg","namespace":"shop","what":"written"}]`
)

// While k8s-service answers without the further sources (ai.timelineChangesMore off) the answer is byte for byte what it
// was: the notes say what they said, and a source k8s-service did not count is not taken for one it read.
func TestTimelineChangesMore_WithoutThemTheAnswerIsAsItWas(t *testing.T) {
	_, out := changesAnswer(t, args{"namespace": "shop"}, offNothing, `[]`)
	if want := `{"view":"changes","namespace":"shop","summary":` + offNothing + `,"hint":"` + offHint + `","changes":[]}`; out != want {
		t.Errorf("answer\n%s\nwant\n%s", out, want)
	}
	m, _ := changesAnswer(t, args{"namespace": "shop"}, `{"changes_total":70,"changes_shown":1,"by_source":{"configmaps":70}}`, oneChange)
	if m["changes_note"] != offCut {
		t.Errorf("changes_note = %q", m["changes_note"])
	}
	// no namespace: the further sources are skipped and null, so they left nothing out
	m, _ = changesAnswer(t, args{}, `{"changes_total":70,"changes_shown":1,"by_source":{"configmaps":70,"jobs":null},"skipped":{"jobs":"read in a named namespace only"}}`, oneChange)
	if m["changes_note"] != offCut {
		t.Errorf("skipped: changes_note = %q", m["changes_note"])
	}
	if note, _ := m["skipped_note"].(string); !strings.Contains(note, "not counted, not zero") {
		t.Errorf("skipped_note = %q", note)
	}
}

// With them, a cut list says of what it holds the newest, with the limit asked, and an answer with nothing says what the
// objects keep.
func TestTimelineChangesMore_WithThemTheNotesSayWhatWasReadAndLeftOut(t *testing.T) {
	m, _ := changesAnswer(t, args{"namespace": "shop", "limit": 7}, `{"changes_total":240,"changes_shown":1,"by_source":{"configmaps":1,"jobs":239}}`, oneChange)
	if want := "1 of the 240 changes in this window are listed: the newest 7 at most, of the Jobs the newest 15 and of one CronJob's the newest 4; summary.by_source counts them all by source."; m["changes_note"] != want {
		t.Errorf("changes_note = %q, want %q", m["changes_note"], want)
	}
	m, _ = changesAnswer(t, args{"namespace": "shop"}, `{"changes_total":0,"changes_shown":0,"by_source":{"rollouts":0,"jobs":0,"networkpolicies":0,"services":0,"deployment_replicas":0,"statefulset_replicas":0}}`, `[]`)
	hint, _ := m["hint"].(string)
	for _, kept := range []string{"NetworkPolicy", "Service", "replica count"} {
		if !strings.Contains(hint, kept) {
			t.Errorf("hint %q does not say %s", hint, kept)
		}
	}
	// a kind that could not be read is not "nothing changed"
	m, _ = changesAnswer(t, args{"namespace": "shop"}, `{"changes_total":0,"changes_shown":0,"by_source":{"rollouts":0,"jobs":null},"not_read":{"jobs":"not readable: list jobs: forbidden"}}`, `[]`)
	if _, said := m["hint"]; said {
		t.Errorf("a refused kind reads as nothing changed: %v", m)
	}
	if note, _ := m["not_read_note"].(string); !strings.Contains(note, "could not be read") {
		t.Errorf("not_read_note = %q", note)
	}
}
