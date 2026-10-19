package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/alerts"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func newAlertFixture(t *testing.T) (*Handler, *[]*http.Request) {
	t.Helper()
	var seen []*http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r)
		switch r.URL.Path {
		case "/api/datasources/proxy/uid/am/api/v2/alerts":
			_, _ = w.Write([]byte(`[
			 {"fingerprint":"a1","labels":{"alertname":"KubePodCrashLooping","severity":"warning","cluster":"kubeast","namespace":"shop"},"annotations":{"summary":"cart"},
			  "startsAt":"2026-10-19T06:00:00Z","status":{"state":"suppressed","silencedBy":["s1"],"inhibitedBy":[]}},
			 {"fingerprint":"b1","labels":{"alertname":"KubePodCrashLooping","severity":"warning","cluster":"prod","namespace":"shop"},"annotations":{"summary":"prod cart"},
			  "startsAt":"2026-10-19T06:00:00Z","status":{"state":"active","silencedBy":[],"inhibitedBy":[]}}]`))
		case "/api/datasources/proxy/uid/am/api/v2/silences":
			_, _ = w.Write([]byte(`[{"id":"s1","matchers":[{"name":"namespace","value":"shop","isRegex":false}],"comment":"deploy","startsAt":"2026-10-19T06:00:00Z","endsAt":"2026-10-19T08:00:00Z","status":{"state":"active"}},
			 {"id":"s9","matchers":[{"name":"cluster","value":"prod","isRegex":false}],"comment":"prod freeze","startsAt":"2026-10-19T06:00:00Z","endsAt":"2026-10-19T08:00:00Z","status":{"state":"active"}}]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	s, err := alerts.New(alerts.Config{Enabled: true, URL: srv.URL + "/api/datasources/proxy/uid/am", ClusterLabel: "cluster",
		Clusters: map[string]string{"self": "kubeast"}, MaxAlerts: 100, Timeout: time.Second, PerUserPerMinute: 3})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{}
	h.SetAlertStore(s)
	return h, &seen
}

func TestAlertStoreAlertsKeepsTheCluster(t *testing.T) {
	h, seen := newAlertFixture(t)
	w := httptest.NewRecorder()
	h.AlertStoreAlerts(w, logSearchRequestAs("/api/v1/alertstore/alerts?label=namespace%3Dshop", "self", "", podReader))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	var res alerts.Result
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if len(res.Alerts) != 1 || res.Alerts[0].Fingerprint != "a1" || res.Alerts[0].State != alerts.StateSilenced ||
		len(res.Silences) != 1 || res.Silences[0].Comment != "deploy" || strings.Contains(w.Body.String(), "prod") {
		t.Fatalf("result %s", w.Body)
	}
	if f := (*seen)[0].URL.Query()["filter"]; strings.Join(f, " ") != `cluster="kubeast" namespace="shop"` {
		t.Fatalf("filter %v", f)
	}
	if h.alertStoreFeature()["enabled"] != true {
		t.Fatal("feature off")
	}
}

func TestAlertStoreAlertsRefusals(t *testing.T) {
	scoped := podReader
	scoped.Namespaces = map[string][]string{"self": {"shop"}}
	noPods := auth.TokenPayload{UserID: "u2", Perms: auth.PermissionMatrix{"*": {"resource.deployment.read"}}}
	for name, c := range map[string]struct {
		target, cluster string
		payload         auth.TokenPayload
		status          int
		says            string
	}{
		"no store for the cluster": {"/api/v1/alertstore/alerts", "default", podReader, http.StatusNotFound, "not configured"},
		"no pod read":              {"/api/v1/alertstore/alerts", "self", noPods, http.StatusForbidden, ""},
		"namespace grant":          {"/api/v1/alertstore/alerts", "self", scoped, http.StatusForbidden, "limited to namespaces"},
		"bad state":                {"/api/v1/alertstore/alerts?state=pending", "self", podReader, http.StatusBadRequest, "state"},
		"label without a value":    {"/api/v1/alertstore/alerts?label=team", "self", podReader, http.StatusBadRequest, "name=value"},
		"bad label name":           {"/api/v1/alertstore/alerts?label=a-b%3Dc", "self", podReader, http.StatusBadRequest, "label name"},
	} {
		t.Run(name, func(t *testing.T) {
			h, seen := newAlertFixture(t)
			w := httptest.NewRecorder()
			h.AlertStoreAlerts(w, logSearchRequestAs(c.target, c.cluster, "", c.payload))
			if w.Code != c.status || !strings.Contains(w.Body.String(), c.says) || len(*seen) != 0 {
				t.Fatalf("%d %s (store asked %d times)", w.Code, w.Body, len(*seen))
			}
		})
	}
	// the per-user rate (3 a minute in the fixture); refused requests do not use it up
	h, _ := newAlertFixture(t)
	var w *httptest.ResponseRecorder
	for i := 0; i < 3; i++ {
		h.AlertStoreAlerts(httptest.NewRecorder(), logSearchRequestAs("/api/v1/alertstore/alerts?state=pending", "self", "", podReader))
	}
	for i, want := range []int{http.StatusOK, http.StatusOK, http.StatusOK, http.StatusTooManyRequests} {
		w = httptest.NewRecorder()
		h.AlertStoreAlerts(w, logSearchRequestAs("/api/v1/alertstore/alerts", "self", "", podReader))
		if w.Code != want {
			t.Fatalf("read %d: %d, want %d", i+1, w.Code, want)
		}
	}
	if (&Handler{}).alertStoreFeature()["enabled"] != false {
		t.Fatal("feature on without a store")
	}
}
