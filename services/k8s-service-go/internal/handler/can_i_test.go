package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type canIRegistry struct{ blob string }

func (canIRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (r canIRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: r.blob}, nil
}
func (canIRegistry) Default(context.Context) (cluster.ID, error) { return "c", nil }

// The console's create and delete buttons ask /can-i; a delete names its object, and the review the API server gets
// carries that name (RBAC resourceNames can allow one object only) — and nothing for a create.
func TestCanI_AsksAboutTheNamedObject(t *testing.T) {
	var got []authorizationv1.ResourceAttributes
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" {
			http.NotFound(w, r)
			return
		}
		// client-go may send protobuf: the scheme's deserializer reads either
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil || review.Spec.ResourceAttributes == nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		attrs := *review.Spec.ResourceAttributes
		got = append(got, attrs)
		review.APIVersion, review.Kind = "authorization.k8s.io/v1", "SelfSubjectAccessReview"
		review.Status.Allowed = attrs.Name == "allowed-one"
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(review)
	}))
	defer api.Close()
	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", api.URL, 1)
	svc, err := k8s.NewService(context.Background(), canIRegistry{blob: blob}, false, nil, k8s.ServiceOptions{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc}

	cases := []struct {
		query   string
		want    authorizationv1.ResourceAttributes
		allowed bool
	}{
		{"verb=delete&resource=configmaps&namespace=ns-a&name=allowed-one",
			authorizationv1.ResourceAttributes{Verb: "delete", Resource: "configmaps", Namespace: "ns-a", Name: "allowed-one"}, true},
		{"verb=delete&group=rbac.authorization.k8s.io&resource=clusterroles&name=other",
			authorizationv1.ResourceAttributes{Verb: "delete", Group: "rbac.authorization.k8s.io", Resource: "clusterroles", Name: "other"}, false},
		{"verb=create&resource=endpoints&namespace=ns-a",
			authorizationv1.ResourceAttributes{Verb: "create", Resource: "endpoints", Namespace: "ns-a"}, false},
	}
	for _, tc := range cases {
		got = nil
		req := httptest.NewRequest(http.MethodGet, "/api/v1/can-i?"+tc.query, nil)
		req = req.WithContext(cluster.WithID(req.Context(), "c"))
		rec := httptest.NewRecorder()
		h.CanI(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d (%s)", tc.query, rec.Code, rec.Body.String())
		}
		var answer struct {
			Allowed bool `json:"allowed"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &answer)
		if len(got) != 1 || got[0] != tc.want || answer.Allowed != tc.allowed {
			t.Errorf("%s: asked %+v answered %v, want asked %+v answered %v", tc.query, got, answer.Allowed, tc.want, tc.allowed)
		}
	}
}
