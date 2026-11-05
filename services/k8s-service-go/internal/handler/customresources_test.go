package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
)

// A screen loaded before the answer named the kinds it could not list reads the instances as a list; the screen
// asking with with_unlisted=1 gets them with those kinds.
func TestCustomResourceInstancesBody(t *testing.T) {
	data := &k8s.CustomResourceInstances{
		Items:          []map[string]interface{}{{"name": "w1", "kind": "Widget"}},
		ForbiddenKinds: []string{"GuardCheck"},
		FailedKinds:    []k8s.CustomResourceListFailure{{Kind: "Thing", Code: 500, Error: "boom"}},
	}
	encode := func(target string, data *k8s.CustomResourceInstances) string {
		raw, err := json.Marshal(customResourceInstancesBody(httptest.NewRequest("GET", target, nil), data))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	for _, target := range []string{"/api/v1/custom-resources/all", "/api/v1/custom-resources/all?force_refresh=false", "/api/v1/custom-resources/all?with_unlisted=0"} {
		if got, want := encode(target, data), `[{"kind":"Widget","name":"w1"}]`; got != want {
			t.Errorf("%s = %s, want the instances alone %s", target, got, want)
		}
	}
	want := `{"items":[{"kind":"Widget","name":"w1"}],"forbidden_kinds":["GuardCheck"],"failed_kinds":[{"kind":"Thing","code":500,"error":"boom"}]}`
	if got := encode("/api/v1/custom-resources/all?force_refresh=false&with_unlisted=1", data); got != want {
		t.Errorf("with_unlisted=1 = %s, want %s", got, want)
	}
	if got := encode("/api/v1/custom-resources/all", &k8s.CustomResourceInstances{Items: []map[string]interface{}{}}); got != `[]` {
		t.Errorf("no instances, the list alone = %s, want []", got)
	}
}
