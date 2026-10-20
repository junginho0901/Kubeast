package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/alerts"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func silenceFixture(t *testing.T, on bool) (*Handler, *memAudit, *[]string) {
	t.Helper()
	var writes []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/silences":
			body, _ := io.ReadAll(r.Body)
			writes = append(writes, "POST "+string(body))
			_, _ = w.Write([]byte(`{"silenceID":"sil-1"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/silence/sil-1":
			_, _ = w.Write([]byte(`{"id":"sil-1","matchers":[{"name":"alertname","value":"X","isRegex":false,"isEqual":true},{"name":"cluster","value":"kubeast","isRegex":false,"isEqual":true}],"comment":"deploy","createdBy":"dev@example.com","status":{"state":"active"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/silence/other":
			_, _ = w.Write([]byte(`{"id":"other","matchers":[{"name":"cluster","value":"prod","isRegex":false,"isEqual":true}],"status":{"state":"active"}}`))
		case r.Method == http.MethodDelete:
			writes = append(writes, "DELETE "+r.URL.Path)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/alerts":
			_, _ = w.Write([]byte(`[{"fingerprint":"a1","labels":{"alertname":"X","cluster":"kubeast"},"annotations":{},"startsAt":"2026-10-20T05:00:00Z","status":{"state":"active"}}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	s, err := alerts.New(alerts.Config{Enabled: true, URL: srv.URL, ClusterLabel: "cluster", Clusters: map[string]string{"self": "kubeast"},
		MaxAlerts: 100, Timeout: time.Second, PerUserPerMinute: 30, SilencesEnabled: on, SilenceMaxDuration: 168 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	store := &memAudit{}
	h := &Handler{auditStore: store}
	h.SetAlertStore(s)
	return h, store, &writes
}

func silenceRequest(method, target, body, silenceID string, payload auth.TokenPayload) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	ctx := context.WithValue(r.Context(), auth.TokenPayloadContextKey(), payload)
	ctx = cluster.WithID(ctx, cluster.ID("self"))
	rc := chi.NewRouteContext()
	if silenceID != "" {
		rc.URLParams.Add("silenceID", silenceID)
	}
	ctx = context.WithValue(ctx, chi.RouteCtxKey, rc)
	return r.WithContext(ctx)
}

var silencer = auth.TokenPayload{UserID: "u1", Email: "dev@example.com", Perms: auth.PermissionMatrix{"self": {"resource.pod.read", "resource.alert.silence"}}}

const silenceBody = `{"matchers":[{"name":"alertname","value":"X","isRegex":false,"isEqual":true}],"durationMinutes":120,"comment":"deploy"}`

func TestASilenceIsMadeForTheClusterAndAudited(t *testing.T) {
	h, store, writes := silenceFixture(t, true)
	w := httptest.NewRecorder()
	h.CreateAlertSilence(w, silenceRequest(http.MethodPost, "/api/v1/alertstore/silences", silenceBody, "", silencer))
	if w.Code != http.StatusCreated || !strings.Contains(w.Body.String(), `"silenceID":"sil-1"`) {
		t.Fatalf("create %d %s", w.Code, w.Body)
	}
	if len(*writes) != 1 || !strings.Contains((*writes)[0], `"name":"cluster","value":"kubeast"`) || !strings.Contains((*writes)[0], `"createdBy":"dev@example.com"`) {
		t.Fatalf("store got %v", *writes)
	}
	row := store.rows[len(store.rows)-1]
	if row.Action != "alert.silence.create" || row.TargetID != "sil-1" || row.Result != "success" || !strings.Contains(string(row.After), `cluster=\"kubeast\"`) {
		t.Fatalf("audit %+v %s", row, row.After)
	}

	w = httptest.NewRecorder()
	h.ExpireAlertSilence(w, silenceRequest(http.MethodDelete, "/api/v1/alertstore/silences/sil-1", "", "sil-1", silencer))
	if w.Code != http.StatusOK || (*writes)[1] != "DELETE /api/v2/silence/sil-1" {
		t.Fatalf("expire %d %s %v", w.Code, w.Body, *writes)
	}
	if row := store.rows[len(store.rows)-1]; row.Action != "alert.silence.expire" || row.Result != "success" || !strings.Contains(string(row.After), "deploy") {
		t.Fatalf("expire audit %+v", row)
	}

	// another cluster's silence is not found, and the refusal is a failure row
	w = httptest.NewRecorder()
	h.ExpireAlertSilence(w, silenceRequest(http.MethodDelete, "/api/v1/alertstore/silences/other", "", "other", silencer))
	if w.Code != http.StatusNotFound || len(*writes) != 2 {
		t.Fatalf("other cluster %d %v", w.Code, *writes)
	}
	if row := store.rows[len(store.rows)-1]; row.Action != "alert.silence.expire" || row.Result != "failure" {
		t.Fatalf("failure row %+v", row)
	}
}

func TestSilenceWritesAreRefused(t *testing.T) {
	readOnly := auth.TokenPayload{UserID: "u2", Email: "r@example.com", Perms: auth.PermissionMatrix{"self": {"resource.pod.read"}}}
	scoped := silencer
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	for name, c := range map[string]struct {
		on      bool
		payload auth.TokenPayload
		body    string
		status  int
	}{
		"no silence permission": {true, readOnly, silenceBody, http.StatusForbidden},
		"namespace grant":       {true, scoped, silenceBody, http.StatusForbidden},
		"silences off":          {false, silencer, silenceBody, http.StatusNotFound},
		"cluster condition":     {true, silencer, `{"matchers":[{"name":"cluster","value":"prod","isEqual":true}],"durationMinutes":60,"comment":"x"}`, http.StatusBadRequest},
		"not JSON":              {true, silencer, `nope`, http.StatusBadRequest},
	} {
		h, store, writes := silenceFixture(t, c.on)
		w := httptest.NewRecorder()
		h.CreateAlertSilence(w, silenceRequest(http.MethodPost, "/api/v1/alertstore/silences", c.body, "", c.payload))
		if w.Code != c.status || len(*writes) != 0 {
			t.Errorf("%s: %d %s, store writes %v", name, w.Code, w.Body, *writes)
		}
		if name == "no silence permission" && (len(store.rows) != 1 || store.rows[0].Action != "k8s.access.denied") {
			t.Errorf("%s: audit %+v", name, store.rows)
		}
		if (name == "silences off" || name == "cluster condition") && (len(store.rows) != 1 || store.rows[0].Action != "alert.silence.create" || store.rows[0].Result != "failure") {
			t.Errorf("%s: audit %+v", name, store.rows)
		}
	}
}

func TestSilenceListAndPreviewAreReads(t *testing.T) {
	h, store, _ := silenceFixture(t, false)
	ms, _ := json.Marshal([]alerts.Matcher{{Name: "alertname", Value: "X", IsEqual: true}})
	w := httptest.NewRecorder()
	h.AlertStoreSilencePreview(w, silenceRequest(http.MethodGet, "/api/v1/alertstore/silences/preview?matchers="+url.QueryEscape(string(ms)), "", "", podReaderOn("self")))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"total":1`) {
		t.Fatalf("preview %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	h.AlertStoreSilencePreview(w, silenceRequest(http.MethodGet, "/api/v1/alertstore/silences/preview?matchers=nope", "", "", podReaderOn("self")))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad matchers %d", w.Code)
	}
	if len(store.rows) != 0 {
		t.Fatalf("a read wrote audit rows: %+v", store.rows)
	}
	if f := h.alertStoreFeature(); f["silences"] != false || f["silenceMaxHours"] != 168 {
		t.Fatalf("feature %v", f)
	}
}

func podReaderOn(id string) auth.TokenPayload {
	return auth.TokenPayload{UserID: "u3", Email: "p@example.com", Perms: auth.PermissionMatrix{id: {"resource.pod.read"}}}
}
