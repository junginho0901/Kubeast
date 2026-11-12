package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	fakedynamic "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// A Secret applied with kubectl keeps a copy of its values in this annotation, plain stringData included. The YAML shows
// it with the values to a caller who may reveal; a describe (the drawer's Info) masks it for everyone.
func TestSecretReadsHideTheLastAppliedCopyWithoutReveal(t *testing.T) {
	const value = "fake-last-applied-value"
	const lastKey = "kubectl.kubernetes.io/last-applied-configuration"
	lastValue := `{"kind":"Secret","stringData":{"conf":"{ ` + value + ` }"}}`
	anno := map[string]interface{}{lastKey: lastValue, "team": "shop"}
	object := func(kind, name string) map[string]interface{} {
		return map[string]interface{}{"apiVersion": "v1", "kind": kind, "metadata": map[string]interface{}{"name": name, "namespace": "shop", "annotations": anno}}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/secrets/db"):
			_ = json.NewEncoder(w).Encode(object("Secret", "db"))
		case strings.HasSuffix(r.URL.Path, "/configmaps/cfg"):
			_ = json.NewEncoder(w).Encode(object("ConfigMap", "cfg"))
		default:
			_, _ = w.Write([]byte(`{"kind":"EventList","apiVersion":"v1","metadata":{},"items":[]}`))
		}
	}))
	defer srv.Close()
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: 1000, Burst: 1000})
	if err != nil {
		t.Fatal(err)
	}
	obj := &unstructured.Unstructured{Object: object("Secret", "db")}
	obj.Object["data"] = map[string]interface{}{"conf": "eA=="}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs, dynamic: fakedynamic.NewSimpleDynamicClient(runtime.NewScheme(), obj)})
	ctx := context.Background()

	for _, reveal := range []bool{false, true} {
		desc, err := s.DescribeSecret(ctx, "shop", "db", reveal)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := desc["annotations"].(map[string]string)
		if _, listed := got[lastKey]; !listed || got["team"] != "shop" {
			t.Errorf("describe reveal=%v: the annotation stays listed and the others stay: %v", reveal, got)
		}
		if got[lastKey] != SecretMask {
			t.Errorf("describe reveal=%v: %q", reveal, got[lastKey])
		}
		yaml, err := s.GetSecretYAML(ctx, "shop", "db", reveal)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(yaml, lastKey) || !strings.Contains(yaml, "team: shop") {
			t.Errorf("yaml reveal=%v: the annotation stays listed and the others stay:\n%s", reveal, yaml)
		}
		if strings.Contains(yaml, value) != reveal {
			t.Errorf("yaml reveal=%v:\n%s", reveal, yaml)
		}
	}

	desc, err := s.DescribeConfigMap(ctx, "shop", "cfg")
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := desc["annotations"].(map[string]string); !strings.Contains(got[lastKey], value) {
		t.Errorf("another kind keeps its annotation: %v", got)
	}
}
