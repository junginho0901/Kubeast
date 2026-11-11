package handler_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
)

// A YAML of two objects whose second the cluster refuses: the first stays made, so the refusal names it with the
// reason, and the audit row counts it. A refusal of the first object answers as before, with nothing made.
func TestYAMLCreateStoppedPartWayNamesWhatItMade(t *testing.T) {
	doc := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first\n  namespace: shop\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: shop\n"
	type answer struct {
		Detail  string                   `json:"detail"`
		Created []map[string]interface{} `json:"created"`
	}
	create := func(t *testing.T, fails string) (*argoCluster, *argoRig, int, answer) {
		t.Helper()
		a := newArgoCluster(t)
		a.writeFails[fails] = http.StatusConflict
		rig := newArgoRigWith(t, a, argoOff, argoWriter(), config.Config{})
		w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": doc}))
		var got answer
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("answer %d %q: %v", w.Code, w.Body.String(), err)
		}
		return a, rig, w.Code, got
	}

	a, rig, code, got := create(t, "services")
	if code != http.StatusConflict || !strings.Contains(got.Detail, "create Service web") || !strings.Contains(got.Detail, "AlreadyExists") {
		t.Fatalf("second refused: %d %+v", code, got)
	}
	if len(got.Created) != 1 || got.Created[0]["kind"] != "ConfigMap" || got.Created[0]["namespace"] != "shop" {
		t.Fatalf("what was made before it stopped: %+v", got.Created)
	}
	if writes := a.seenWrites(); len(writes) != 1 || !strings.Contains(writes[0], "/configmaps") {
		t.Fatalf("writes %v", writes)
	}
	rig.audit.mu.Lock()
	var after []map[string]interface{}
	var results []string
	for _, row := range rig.audit.rows {
		if row.Action != "k8s.yaml.create" {
			continue
		}
		m := map[string]interface{}{}
		_ = json.Unmarshal(row.After, &m)
		after, results = append(after, m), append(results, string(row.Result))
	}
	rig.audit.mu.Unlock()
	if len(after) != 1 || results[0] != "failure" || after[0]["objects_created"] != float64(1) {
		t.Fatalf("audit rows %v %v", results, after)
	}

	_, _, code, got = create(t, "configmaps")
	if code != http.StatusConflict || !strings.Contains(got.Detail, "create ConfigMap first") || got.Created != nil {
		t.Fatalf("first refused: %d %+v", code, got)
	}
}

// What the caller wrote wrong is a 400 with its reason and no write: text that is not an object, a YAML of comments
// only (which made nothing and answered 200 before), a kind left out and one the cluster does not serve; a document
// after one that was made still answers it as made.
func TestYAMLCreateOfTextThatIsNoObjectIsA400(t *testing.T) {
	type answer struct {
		Detail  string                   `json:"detail"`
		Created []map[string]interface{} `json:"created"`
	}
	cases := []struct{ name, yaml, detail string }{
		{"text", "한국어 글\n", "document 1 (line 1) is text, not an object with apiVersion, kind and metadata"},
		{"comments only", "# a note\n---\n", "no objects passed to create: the YAML holds only comments or empty documents"},
		{"no kind", "apiVersion: v1\nmetadata: {name: x}\n", "document 1: kind not set"},
		{"kind not served", "apiVersion: v1\nkind: ForbiddenThing\nmetadata: {name: x}\n", `document 1: no matches for kind "ForbiddenThing" in version "v1"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := newArgoCluster(t)
			rig := newArgoRigWith(t, a, argoOff, argoWriter(), config.Config{})
			w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": tc.yaml}))
			var got answer
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatalf("answer %d %q: %v", w.Code, w.Body.String(), err)
			}
			if w.Code != http.StatusBadRequest || !strings.HasPrefix(got.Detail, tc.detail) || got.Created != nil {
				t.Fatalf("answer %d %+v, want 400 %q", w.Code, got, tc.detail)
			}
			if writes := a.seenWrites(); len(writes) != 0 {
				t.Fatalf("writes %v", writes)
			}
		})
	}

	a := newArgoCluster(t)
	rig := newArgoRigWith(t, a, argoOff, argoWriter(), config.Config{})
	w := rig.do("POST", "/api/v1/resources/yaml/create", jsonBody(t, map[string]string{"yaml": "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first\n  namespace: shop\n---\njust text\n"}))
	var got answer
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if w.Code != http.StatusBadRequest || got.Detail != "document 2 (line 7) is text, not an object with apiVersion, kind and metadata" ||
		len(got.Created) != 1 || got.Created[0]["kind"] != "ConfigMap" {
		t.Fatalf("made before the text: %d %+v", w.Code, got)
	}
}
