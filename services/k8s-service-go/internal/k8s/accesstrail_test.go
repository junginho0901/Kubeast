package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A cluster request made for a recorded AI tool call goes out with the user's
// impersonation headers and its own Audit-ID, and is listed with that ID; the
// same request outside a recorded call carries no Audit-ID.
func TestRecordedRequestsCarryAuditIDAndIdentity(t *testing.T) {
	type seen struct{ auditID, user string }
	var mu sync.Mutex
	var got []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, seen{r.Header.Get("Audit-ID"), r.Header.Get("Impersonate-User")})
		mu.Unlock()
		w.Header().Set("Audit-Id", r.Header.Get("Audit-ID"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"kind":"PodList","apiVersion":"v1","items":[]}`))
	}))
	defer srv.Close()
	kc := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)
	reg := &mockRegistry{def: "a", clusters: map[cluster.ID]cluster.Info{"a": {ID: "a", Mode: cluster.ModeExternal, KubeconfigBlob: kc}}}
	s, err := NewService(context.Background(), reg, false, nil, ServiceOptions{MaxClusters: 20, Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { impersonationEnabled = false })

	user := auth.WithPayload(cluster.WithID(context.Background(), "a"), auth.TokenPayload{UserID: "u1", Email: "reader@example.com", Roles: map[string]string{"a": "Read"}})
	if _, err := s.clientsetCtx(user).CoreV1().Pods("shop").List(user, metav1.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	rec := &accesstrail.Recorder{}
	recorded := accesstrail.NewContext(user, rec)
	if _, err := s.clientsetCtx(recorded).CoreV1().Pods("shop").List(recorded, metav1.ListOptions{}); err != nil {
		t.Fatal(err)
	}

	if len(got) != 2 || got[0].auditID != "" || got[0].user != "reader@example.com" {
		t.Fatalf("unrecorded request: %+v", got)
	}
	if got[1].user != "reader@example.com" || !strings.HasPrefix(got[1].auditID, "kubeast-") {
		t.Fatalf("recorded request: %+v", got[1])
	}
	trail := rec.Snapshot()
	if trail.Total != 1 {
		t.Fatalf("trail %+v", trail)
	}
	r := trail.Requests[0]
	if r.AuditID != got[1].auditID || !r.Echoed || r.Status != 200 || r.Verb != "list" || r.Resource != "pods" || r.Namespace != "shop" {
		t.Fatalf("listed %+v, sent %s", r, got[1].auditID)
	}
}
