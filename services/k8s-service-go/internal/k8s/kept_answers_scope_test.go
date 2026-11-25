package k8s

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// keptFor are tokens whose identity in the cluster is the same whatever namespaces their grant is limited to.
var keptFor = map[string]func(namespaces ...string) context.Context{
	"a person": func(namespaces ...string) context.Context {
		return keptContext(auth.TokenPayload{UserID: "u1", Email: "a@example.com", Roles: map[string]string{"default": "team"}}, namespaces)
	},
	"the investigator": func(namespaces ...string) context.Context {
		return keptContext(auth.TokenPayload{UserID: "system", Email: auth.UserInvestigator, System: auth.SystemInvestigator}, namespaces)
	},
}

func keptContext(p auth.TokenPayload, namespaces []string) context.Context {
	if len(namespaces) > 0 {
		p.Namespaces = map[string][]string{"default": namespaces}
	}
	return auth.WithPayload(context.Background(), p)
}

// The policy reports kept for a view with no namespace are those of the grant that read them: another grant of the same
// identity reads its own, and the same grant is answered from them.
func TestPolicyReportsKeptForOneGrantAreNotAnothers(t *testing.T) {
	for name, token := range keptFor {
		t.Run(name, func(t *testing.T) {
			s, srv := newPolicyReportService(t)
			for _, tc := range []struct {
				grant   []string
				reports int
				fails   int
			}{
				{[]string{"apps"}, 2, 2},
				{[]string{"kube-system"}, 1, 1},
				{nil, 4, 3},
				{[]string{"kube-system", "apps"}, 3, 3},
			} {
				ctx := token(tc.grant...)
				sum, err := s.PolicyReportSummary(ctx, "", false)
				if err != nil {
					t.Fatal(err)
				}
				if sum.Reports != tc.reports || sum.Totals.Fail != tc.fails || sum.Scoped != (len(tc.grant) > 0) {
					t.Errorf("a grant of %v: %d reports, %d failed, want %d and %d", tc.grant, sum.Reports, sum.Totals.Fail, tc.reports, tc.fails)
				}
				res, err := s.PolicyReportResults(ctx, PolicyReportFilter{})
				if err != nil {
					t.Fatal(err)
				}
				for _, row := range res.Rows {
					if row.Namespace != "" && !inCallerScope(ctx, row.Namespace) {
						t.Errorf("a grant of %v is given a row of %s", tc.grant, row.Namespace)
					}
				}
			}
			lists := srv.count("policyreports")
			if _, err := s.PolicyReportSummary(token("apps", "kube-system"), "", false); err != nil {
				t.Fatal(err)
			}
			if now := srv.count("policyreports"); now != lists {
				t.Errorf("the same grant, its namespaces in another order, read the reports again: %d lists", now-lists)
			}
			if kept := len(policyReportCacheFor("default").sets); kept != 4 {
				t.Errorf("%d answers kept for four grants", kept)
			}
		})
	}
}

// The overview kept while no informers answer counts the namespaces of the grant that asked.
func TestAnOverviewKeptForOneGrantIsNotAnothers(t *testing.T) {
	var calls atomic.Int64
	pods := map[string]int{"a": 2, "b": 3}
	list := func(n int) string {
		return `{"items":[` + strings.TrimSuffix(strings.Repeat(`{"metadata":{"name":"x"}},`, n), ",") + `]}`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		namespace, kind, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/api/v1/namespaces/"), "/")
		switch {
		case kind == "pods":
			_, _ = w.Write([]byte(list(pods[namespace])))
		case r.URL.Path == "/api/v1/pods":
			_, _ = w.Write([]byte(list(pods["a"] + pods["b"])))
		case kind == "" && namespace != "":
			_, _ = w.Write([]byte(`{"kind":"Namespace","apiVersion":"v1","metadata":{"name":"` + namespace + `"}}`))
		default:
			_, _ = w.Write([]byte(list(0)))
		}
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	for name, token := range keptFor {
		t.Run(name, func(t *testing.T) {
			s := &Service{cache: cache.New("", 0, 0, "")}
			s.defaultBundle.Store(&clientBundle{clientset: cs})
			for _, tc := range []struct {
				grant []string
				pods  int
			}{{[]string{"a"}, 2}, {[]string{"b"}, 3}, {[]string{"b", "a"}, 5}, {nil, 5}, {[]string{"a"}, 2}} {
				ov, err := s.GetClusterOverview(token(tc.grant...))
				if err != nil {
					t.Fatal(err)
				}
				// the count is read from the cluster as an int and from the cache as a JSON number
				if got := fmt.Sprint(ov["total_pods"]); got != fmt.Sprint(tc.pods) || (ov["scoped"] == true) != (len(tc.grant) > 0) {
					t.Errorf("a grant of %v: %s pods, scoped %v, want %d", tc.grant, got, ov["scoped"], tc.pods)
				}
			}
			before := calls.Load()
			if _, err := s.GetClusterOverview(token("a", "b")); err != nil {
				t.Fatal(err)
			}
			if now := calls.Load(); now != before {
				t.Errorf("the same grant, its namespaces in another order, asked the cluster again: %d calls", now-before)
			}
		})
	}
}
