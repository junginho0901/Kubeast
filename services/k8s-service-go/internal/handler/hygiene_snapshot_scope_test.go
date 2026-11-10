package handler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/hygiene"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type oneReview struct{ review hygiene.Review }

func (s *oneReview) Create(context.Context, *hygiene.Review) error { return nil }
func (s *oneReview) List(context.Context, string, int) ([]hygiene.Review, error) {
	return nil, nil
}
func (s *oneReview) Page(context.Context, string, int, int) ([]hygiene.Review, int, error) {
	return nil, 0, nil
}
func (s *oneReview) Get(_ context.Context, clusterID, id string) (*hygiene.Review, error) {
	if clusterID != s.review.Cluster || id != s.review.ID {
		return nil, hygiene.ErrNotFound
	}
	r := s.review
	return &r, nil
}

// A report a global admin signed holds what only a global admin reads of Kubeast's own namespace: its TLS Secrets and
// the Helm releases kept in Secrets there. A cluster Admin's own scan leaves them out, and so does the snapshot it
// reads, its counts with them; everything else of the report, and the whole of it for a global admin, stays.
func TestASignedReportShowsTheInstallNamespacesSecretsToGlobalAdminsOnly(t *testing.T) {
	report := k8s.HygieneReport{
		GeneratedAt: "2026-11-08T00:00:00Z",
		Counts:      k8s.HygieneCounts{Critical: 2, Warning: 2, Exempt: 1},
		Checks: []k8s.HygieneCheckSummary{
			{HygieneCheck: k8s.HygieneCheck{ID: "image.latest", Severity: "warning"}, Findings: 1, Severities: map[string]int{"warning": 1}, Applies: true},
			{HygieneCheck: k8s.HygieneCheck{ID: "tls.expiry", Severity: "warning"}, Findings: 2, Exempt: 1, Severities: map[string]int{"critical": 1, "warning": 1}, Applies: true},
			{HygieneCheck: k8s.HygieneCheck{ID: "upgrade.removed-api.helm", Severity: "critical"}, Findings: 1, Severities: map[string]int{"critical": 1}, Applies: true},
		},
		Findings: []k8s.HygieneFinding{
			{Check: "tls.expiry", Severity: "critical", Kind: "Secret", Namespace: installNS, Name: "kubeast-tls", Message: "expires 2026-11-10 (2 days) · sign-in.example.test"},
			{Check: "upgrade.removed-api.helm", Severity: "critical", Kind: "Ingress", Namespace: installNS, Name: "kubeast/kubeast-ingress", Message: "Helm release kubeast renders Ingress"},
			{Check: "tls.expiry", Severity: "warning", Kind: "Secret", Namespace: installNS, Name: "kubeast-exempt-tls", Message: "expires 2026-11-30", Exempt: true},
			{Check: "tls.expiry", Severity: "warning", Kind: "Secret", Namespace: "shop", Name: "shop-tls", Message: "expires 2026-11-30 (22 days) · shop.example.test"},
			{Check: "image.latest", Severity: "warning", Kind: "Deployment", Namespace: installNS, Name: "kubeast-web", Message: "image nginx:latest"},
		},
		Collectors: []k8s.HygieneCollector{},
	}
	snapshot, _ := json.Marshal(map[string]interface{}{"cluster": "c", "report": report})
	counts, _ := json.Marshal(report.Counts)
	store := &oneReview{review: hygiene.Review{ID: "r1", Cluster: "c", ReviewedByEmail: "admin@example.com", ReviewedAt: time.Now(), Counts: counts, Snapshot: snapshot}}

	t.Setenv("PROMETHEUS_ENABLED", "false")
	api := newStandIn(t)
	blob := strings.Replace(standInKubeconfig, "SERVER", api.srv.URL, 1)
	svc, err := k8s.NewService(context.Background(), protectedRegistry{blob: blob, self: true}, false, cache.New("", 0, 0, ""),
		k8s.ServiceOptions{Impersonation: true, InstallNamespace: installNS, NodeShellNamespace: nodeShellNS})
	if err != nil {
		t.Fatal(err)
	}
	h := handler.New(svc, config.Config{ImpersonationEnabled: true, HygieneEnabled: true, HygieneIntervalDays: 30, PodNamespace: installNS}, &auditRows{})
	h.SetHygieneStore(store)
	read := func(p auth.TokenPayload) (k8s.HygieneReport, string) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/v1/hygiene/snapshot/r1?cluster=c", nil)
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", "r1")
		ctx := context.WithValue(cluster.WithID(auth.WithPayload(r.Context(), p), "c"), chi.RouteCtxKey, rc)
		w := httptest.NewRecorder()
		h.HygieneSnapshot(w, r.WithContext(ctx))
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
		var got struct {
			Snapshot struct {
				Report k8s.HygieneReport `json:"report"`
			} `json:"snapshot"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Snapshot.Report, w.Body.String()
	}

	got, body := read(adminOnCluster())
	for _, hidden := range []string{"kubeast-tls", "kubeast-exempt-tls", "sign-in.example.test", "kubeast-ingress"} {
		if strings.Contains(body, hidden) {
			t.Errorf("a cluster Admin reads %q", hidden)
		}
	}
	var names []string
	for _, f := range got.Findings {
		names = append(names, f.Name)
	}
	if strings.Join(names, ",") != "shop-tls,kubeast-web" {
		t.Errorf("findings %v, want shop-tls and kubeast-web", names)
	}
	if got.Counts != (k8s.HygieneCounts{Warning: 2}) {
		t.Errorf("counts %+v, want the two findings shown", got.Counts)
	}
	for _, c := range got.Checks {
		want := map[string]string{"image.latest": "1 0 map[warning:1]", "tls.expiry": "1 0 map[warning:1]", "upgrade.removed-api.helm": "0 0 map[]"}[c.ID]
		if s := fmt.Sprintf("%d %d %v", c.Findings, c.Exempt, c.Severities); s != want || !c.Applies {
			t.Errorf("check %s: %s applies %v, want %s", c.ID, s, c.Applies, want)
		}
	}

	whole, body := read(globalAdminPayload())
	if len(whole.Findings) != 5 || whole.Counts != report.Counts || !strings.Contains(body, "sign-in.example.test") {
		t.Errorf("a global admin reads %d findings, counts %+v", len(whole.Findings), whole.Counts)
	}
}
