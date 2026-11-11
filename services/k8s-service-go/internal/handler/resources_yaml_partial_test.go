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
