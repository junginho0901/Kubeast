package handler

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/hygiene"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

type memHygieneStore struct{ reviews []hygiene.Review }

func (m *memHygieneStore) Create(_ context.Context, r *hygiene.Review) error {
	m.reviews = append(m.reviews, *r)
	return nil
}

func (m *memHygieneStore) List(_ context.Context, clusterID string, limit int) ([]hygiene.Review, error) {
	out := []hygiene.Review{}
	for i := len(m.reviews) - 1; i >= 0 && len(out) < limit; i-- {
		if m.reviews[i].Cluster == clusterID {
			r := m.reviews[i]
			r.Snapshot = nil
			out = append(out, r)
		}
	}
	return out, nil
}

func (m *memHygieneStore) Get(_ context.Context, clusterID, id string) (*hygiene.Review, error) {
	for _, r := range m.reviews {
		if r.ID == id && r.Cluster == clusterID {
			return &r, nil
		}
	}
	return nil, hygiene.ErrNotFound
}

var sampleHygiene = k8s.HygieneReport{
	GeneratedAt: "2026-10-08T00:00:00Z",
	Counts:      k8s.HygieneCounts{Warning: 1},
	Checks:      []k8s.HygieneCheckSummary{{HygieneCheck: k8s.HygieneCheck{ID: "image.latest", Severity: "warning", Refs: "Kubernetes Images"}, Findings: 1}},
	Findings:    []k8s.HygieneFinding{{Check: "image.latest", Severity: "warning", Kind: "Deployment", Namespace: "apps", Name: "=HYPERLINK(1)", Pods: 2, Message: "image nginx"}},
	Collectors:  []k8s.HygieneCollector{},
}

func hygieneHandler(enabled bool) (*Handler, *memAudit, *memHygieneStore) {
	store, reviews := &memAudit{}, &memHygieneStore{}
	h := &Handler{auditStore: store, cfg: config.Config{HygieneEnabled: enabled, HygieneIntervalDays: 30}}
	h.SetHygieneStore(reviews)
	h.hygieneScan = func(context.Context, k8s.HygieneOptions) (k8s.HygieneReport, error) { return sampleHygiene, nil }
	return h, store, reviews
}

func hygieneRequest(method, target string, body []byte, perms ...string) *http.Request {
	r := httptest.NewRequest(method, target, bytes.NewReader(body))
	ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": perms}})
	ctx = cluster.WithID(ctx, "self")
	return r.WithContext(ctx)
}

func TestHygieneGates(t *testing.T) {
	h, store, _ := hygieneHandler(false)
	w := httptest.NewRecorder()
	h.GetHygiene(w, hygieneRequest(http.MethodGet, "/api/v1/hygiene", nil, "*"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("disabled: %d", w.Code)
	}
	h, store, _ = hygieneHandler(true)
	cases := []struct {
		name   string
		call   func(http.ResponseWriter, *http.Request)
		target string
		method string
		perms  []string
	}{
		{"report needs read", h.GetHygiene, "/api/v1/hygiene", http.MethodGet, []string{"admin.hygiene.export", "admin.hygiene.signoff"}},
		{"export needs export", h.GetHygiene, "/api/v1/hygiene?format=csv", http.MethodGet, []string{"admin.hygiene.read"}},
		{"signoff needs signoff", h.SignoffHygiene, "/api/v1/hygiene/signoff", http.MethodPost, []string{"admin.hygiene.read", "admin.hygiene.export"}},
		{"history needs read", h.HygieneHistory, "/api/v1/hygiene/history", http.MethodGet, []string{"admin.review.read"}},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		c.call(w, hygieneRequest(c.method, c.target, nil, c.perms...))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: %d", c.name, w.Code)
		}
	}
	if len(store.rows) != 0 {
		t.Errorf("refused requests wrote audit rows: %+v", store.rows)
	}
	w = httptest.NewRecorder()
	h.GetHygiene(w, hygieneRequest(http.MethodGet, "/api/v1/hygiene?format=xml", nil, "admin.hygiene.export"))
	if w.Code != http.StatusBadRequest {
		t.Errorf("format=xml: %d", w.Code)
	}
}

func TestHygieneReportAuditsTheScan(t *testing.T) {
	h, store, _ := hygieneHandler(true)
	w := httptest.NewRecorder()
	h.GetHygiene(w, hygieneRequest(http.MethodGet, "/api/v1/hygiene", nil, "admin.hygiene.read"))
	if w.Code != http.StatusOK {
		t.Fatalf("code %d: %s", w.Code, w.Body)
	}
	var resp hygieneResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Cluster != "self" || !resp.Due || resp.LastReview != nil || len(resp.Report.Findings) != 1 {
		t.Errorf("response = %+v", resp)
	}
	if len(store.rows) != 1 || store.rows[0].Action != "k8s.hygiene.scan" || store.rows[0].Cluster != "self" || !strings.Contains(string(store.rows[0].After), `"warning":1`) {
		t.Fatalf("audit = %+v", store.rows)
	}

	// A failed scan is still recorded, as a failure.
	h.hygieneScan = func(context.Context, k8s.HygieneOptions) (k8s.HygieneReport, error) {
		return k8s.HygieneReport{}, errors.New("boom")
	}
	w = httptest.NewRecorder()
	h.GetHygiene(w, hygieneRequest(http.MethodGet, "/api/v1/hygiene", nil, "admin.hygiene.read"))
	if w.Code == http.StatusOK || len(store.rows) != 2 || store.rows[1].Result != "failure" {
		t.Errorf("failed scan: code %d rows %+v", w.Code, store.rows)
	}
}

func TestHygieneCSVExport(t *testing.T) {
	h, store, _ := hygieneHandler(true)
	w := httptest.NewRecorder()
	h.GetHygiene(w, hygieneRequest(http.MethodGet, "/api/v1/hygiene?format=csv", nil, "admin.hygiene.export"))
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/csv") ||
		!strings.Contains(w.Header().Get("Content-Disposition"), `filename="hygiene-self-`) {
		t.Fatalf("code %d headers %v", w.Code, w.Header())
	}
	body := strings.TrimPrefix(w.Body.String(), "\xef\xbb\xbf")
	rows, err := csv.NewReader(strings.NewReader(body)).ReadAll()
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows %v err %v", rows, err)
	}
	if rows[0][0] != "check" || rows[1][4] != "'=HYPERLINK(1)" || rows[1][6] != "2" || rows[1][10] != "Kubernetes Images" {
		t.Errorf("csv = %v", rows)
	}
	if len(store.rows) != 1 || store.rows[0].Action != "admin.hygiene.export" || !strings.Contains(string(store.rows[0].After), `"format":"csv"`) {
		t.Errorf("audit = %+v", store.rows)
	}
}

func TestHygieneSignoffHistoryAndSnapshot(t *testing.T) {
	h, store, reviews := hygieneHandler(true)
	long, _ := json.Marshal(hygieneSignoffRequest{Note: strings.Repeat("x", hygieneNoteMax+1)})
	w := httptest.NewRecorder()
	h.SignoffHygiene(w, hygieneRequest(http.MethodPost, "/api/v1/hygiene/signoff", long, "admin.hygiene.signoff"))
	if w.Code != http.StatusBadRequest || len(reviews.reviews) != 0 {
		t.Fatalf("long note: %d", w.Code)
	}

	body, _ := json.Marshal(hygieneSignoffRequest{Note: " monthly check "})
	w = httptest.NewRecorder()
	h.SignoffHygiene(w, hygieneRequest(http.MethodPost, "/api/v1/hygiene/signoff", body, "admin.hygiene.signoff"))
	if w.Code != http.StatusCreated || len(reviews.reviews) != 1 {
		t.Fatalf("signoff: %d %s", w.Code, w.Body)
	}
	rev := reviews.reviews[0]
	if rev.Cluster != "self" || rev.Note != "monthly check" || rev.ReviewedByEmail != "admin@example.com" || rev.ReviewedBy == nil ||
		!strings.Contains(string(rev.Snapshot), `"=HYPERLINK(1)"`) {
		t.Errorf("stored review = %+v", rev)
	}
	if last := store.rows[len(store.rows)-1]; last.Action != "admin.hygiene.signoff" || last.TargetID != rev.ID {
		t.Errorf("signoff audit = %+v", last)
	}

	// The report now shows the sign-off and the next due date.
	w = httptest.NewRecorder()
	h.GetHygiene(w, hygieneRequest(http.MethodGet, "/api/v1/hygiene", nil, "admin.hygiene.read"))
	var resp hygieneResponse
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.LastReview == nil || resp.LastReview.ID != rev.ID || resp.NextDue == nil || resp.Due {
		t.Fatalf("after signoff: %+v", resp)
	}
	if due, _ := time.Parse(time.RFC3339, *resp.NextDue); due.Sub(rev.ReviewedAt) < 29*24*time.Hour {
		t.Errorf("next due %s too early for a 30-day interval", *resp.NextDue)
	}

	w = httptest.NewRecorder()
	h.HygieneHistory(w, hygieneRequest(http.MethodGet, "/api/v1/hygiene/history", nil, "admin.hygiene.read"))
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "snapshot") {
		t.Errorf("history: %d %s", w.Code, w.Body)
	}

	snapshot := func(id, clusterID string) *httptest.ResponseRecorder {
		r := hygieneRequest(http.MethodGet, "/api/v1/hygiene/snapshot/"+id, nil, "admin.hygiene.read")
		r = r.WithContext(cluster.WithID(r.Context(), cluster.ID(clusterID)))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", id)
		r = r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rc))
		w := httptest.NewRecorder()
		h.HygieneSnapshot(w, r)
		return w
	}
	if w := snapshot(rev.ID, "self"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "snapshot") {
		t.Errorf("snapshot: %d %s", w.Code, w.Body)
	}
	if last := store.rows[len(store.rows)-1]; last.Action != "admin.hygiene.read" || last.TargetID != rev.ID {
		t.Errorf("snapshot audit = %+v", last)
	}
	if w := snapshot(rev.ID, "other"); w.Code != http.StatusNotFound {
		t.Errorf("snapshot of another cluster: %d", w.Code)
	}
}
