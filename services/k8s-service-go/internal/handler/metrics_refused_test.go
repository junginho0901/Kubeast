package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// refusingMetricsAPI serves metrics.k8s.io in its discovery and answers every list of it with the 403 Status
// kube-apiserver writes for an identity its RBAC does not let list them, and counts the lists asked.
type refusingMetricsAPI struct {
	mu        sync.Mutex
	asked     []string
	discovery atomic.Int64
}

func (a *refusingMetricsAPI) serve(w http.ResponseWriter, r *http.Request) {
	if serveDiscovery(w, r, true, &a.discovery) {
		return
	}
	const prefix = "/apis/metrics.k8s.io/v1beta1/"
	sub, ok := strings.CutPrefix(r.URL.Path, prefix)
	if !ok {
		http.NotFound(w, r)
		return
	}
	a.mu.Lock()
	a.asked = append(a.asked, r.URL.Path)
	a.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = fmt.Fprintf(w, `{"kind":"Status","apiVersion":"v1","metadata":{},"status":"Failure","message":%q,"reason":"Forbidden","details":{"group":"metrics.k8s.io","kind":"%s"},"code":403}`,
		refusalOf(sub), sub[strings.LastIndex(sub, "/")+1:])
}

func (a *refusingMetricsAPI) count() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.asked)
}

// refusalOf is kube-apiserver's message for a list under /apis/metrics.k8s.io/v1beta1/.
func refusalOf(sub string) string {
	resource := sub[strings.LastIndex(sub, "/")+1:]
	where := "at the cluster scope"
	if ns, ok := strings.CutPrefix(strings.TrimSuffix(sub, "/"+resource), "namespaces/"); ok {
		where = fmt.Sprintf("in the namespace %q", ns)
	}
	return fmt.Sprintf(`%s.metrics.k8s.io is forbidden: User "u1" cannot list resource %q in API group "metrics.k8s.io" %s`, resource, resource, where)
}

// Monitoring's reads of a caller the cluster refuses answer 403 with the cluster's words, where RawRequest, which leaves
// the body of a failure unread, gave "get … metrics (status 403): unknown". Nothing of the refusal is kept: the next read
// asks the cluster again.
func TestMonitoringMetricsTheClusterRefusesSayItInTheClustersWords(t *testing.T) {
	cases := []struct {
		name   string
		path   string
		read   func(h *Handler) http.HandlerFunc
		scope  []string
		lists  int
		detail string
	}{
		{name: "nodes", path: "/api/v1/metrics/nodes", read: func(h *Handler) http.HandlerFunc { return h.GetNodeMetrics }, lists: 1,
			detail: refusalOf("nodes")},
		{name: "pods of every namespace", path: "/api/v1/metrics/pods?with_limits=1", read: func(h *Handler) http.HandlerFunc { return h.GetPodMetrics }, lists: 1,
			detail: refusalOf("pods")},
		{name: "pods of one namespace", path: "/api/v1/metrics/pods?namespace=web&with_limits=1", read: func(h *Handler) http.HandlerFunc { return h.GetPodMetrics }, lists: 1,
			detail: refusalOf("namespaces/web/pods")},
		// a grant limited to namespaces is answered from each of its namespaces; with all of them refused, the first one's words
		{name: "pods of a grant limited to namespaces", path: "/api/v1/metrics/pods?with_limits=1", read: func(h *Handler) http.HandlerFunc { return h.GetPodMetrics },
			scope: []string{"web", "shop"}, lists: 2, detail: refusalOf("namespaces/web/pods")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			api := &refusingMetricsAPI{}
			srv := httptest.NewServer(http.HandlerFunc(api.serve))
			defer srv.Close()
			h := metricsHandler(t, srv.URL)
			ask := func() *httptest.ResponseRecorder {
				payload := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}
				if c.scope != nil {
					payload = auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c1": {"resource.objects.read"}}, Namespaces: map[string][]string{"c1": c.scope}}
				}
				sep := "?"
				if strings.Contains(c.path, "?") {
					sep = "&"
				}
				req := httptest.NewRequest(http.MethodGet, c.path+sep+"cluster=c1", nil)
				req = req.WithContext(auth.WithPayload(req.Context(), payload))
				rec := httptest.NewRecorder()
				h.ClusterMiddleware(c.read(h)).ServeHTTP(rec, req)
				return rec
			}
			for round := 1; round <= 2; round++ {
				rec := ask()
				var body struct {
					Detail string `json:"detail"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
					t.Fatalf("round %d: %s (%v)", round, rec.Body.String(), err)
				}
				if rec.Code != http.StatusForbidden || body.Detail != c.detail {
					t.Fatalf("round %d: %d %q, want 403 %q", round, rec.Code, body.Detail, c.detail)
				}
				if got := api.count(); got != c.lists*round {
					t.Fatalf("round %d: %d lists asked in all, want %d: a refusal was kept", round, got, c.lists*round)
				}
				if reads := api.discovery.Load(); reads != 1 {
					t.Fatalf("round %d: %d discovery reads, want one within its minute", round, reads)
				}
			}
			if h.svc.ClusterDown("c1") {
				t.Error("a refusal took the cluster down")
			}
		})
	}
}
