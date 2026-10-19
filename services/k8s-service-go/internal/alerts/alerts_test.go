package alerts

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// fakeAM serves /api/v2/alerts and /api/v2/silences like an Alertmanager that
// ignores the filter (so the store's own check is what keeps other clusters out).
func fakeAM(t *testing.T, alerts, silences string) (*Store, *[]url.Values) {
	t.Helper()
	var seen []url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer am" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		seen = append(seen, r.URL.Query())
		switch r.URL.Path {
		case "/grafana/api/v2/alerts":
			_, _ = w.Write([]byte(alerts))
		case "/grafana/api/v2/silences":
			_, _ = w.Write([]byte(silences))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	s, err := New(Config{Enabled: true, URL: srv.URL + "/grafana", AuthHeader: "Bearer am", ClusterLabel: "cluster",
		Clusters: map[string]string{"alpha": "eks-alpha", "beta": "eks-beta"}, MaxAlerts: 100, Timeout: 5 * time.Second, PerUserPerMinute: 5})
	if err != nil {
		t.Fatal(err)
	}
	return s, &seen
}

const sampleAlerts = `[
 {"fingerprint":"a1","labels":{"alertname":"PodCrashLooping","severity":"warning","cluster":"eks-alpha","namespace":"shop","__private":"x"},
  "annotations":{"summary":"cart restarts"},"startsAt":"2026-10-19T06:00:00Z","receivers":[{"name":"slack"}],
  "status":{"state":"active","silencedBy":[],"inhibitedBy":[]}},
 {"fingerprint":"a2","labels":{"alertname":"NodeDiskFull","severity":"critical","cluster":"eks-alpha"},
  "annotations":{"description":"disk 95%"},"startsAt":"2026-10-19T05:00:00Z","receivers":[{"name":"pager"}],
  "status":{"state":"active","silencedBy":[],"inhibitedBy":[]}},
 {"fingerprint":"a3","labels":{"alertname":"PodCrashLooping","severity":"warning","cluster":"eks-alpha","namespace":"batch"},
  "annotations":{},"startsAt":"2026-10-19T04:00:00Z","receivers":[{"name":"slack"}],
  "status":{"state":"suppressed","silencedBy":["s-alpha"],"inhibitedBy":[]}},
 {"fingerprint":"b1","labels":{"alertname":"NodeDiskFull","severity":"critical","cluster":"eks-beta"},
  "annotations":{},"startsAt":"2026-10-19T03:00:00Z","receivers":[{"name":"pager"}],
  "status":{"state":"suppressed","silencedBy":["s-beta"],"inhibitedBy":[]}},
 {"fingerprint":"n1","labels":{"alertname":"Watchdog","severity":"none"},"annotations":{},"startsAt":"2026-10-19T00:00:00Z",
  "status":{"state":"active"}}
]`

const sampleSilences = `[
 {"id":"s-alpha","matchers":[{"name":"namespace","value":"batch","isRegex":false,"isEqual":true},{"name":"alertname","value":"Pod.*","isRegex":true}],
  "createdBy":"ops@example.com","comment":"nightly batch","startsAt":"2026-10-19T04:00:00Z","endsAt":"2026-10-19T10:00:00Z","status":{"state":"active"}},
 {"id":"s-beta","matchers":[{"name":"cluster","value":"eks-beta","isRegex":false}],"createdBy":"beta@example.com","comment":"beta maintenance",
  "startsAt":"2026-10-19T03:00:00Z","endsAt":"2026-10-19T09:00:00Z","status":{"state":"active"}}
]`

func TestListKeepsTheClusterAndItsSilences(t *testing.T) {
	s, seen := fakeAM(t, sampleAlerts, sampleSilences)
	res, err := s.List(context.Background(), "alpha", Query{})
	if err != nil {
		t.Fatal(err)
	}
	if f := (*seen)[0]["filter"]; len(f) != 1 || f[0] != `cluster="eks-alpha"` {
		t.Fatalf("filter sent: %v", f)
	}
	if res.Total != 3 || len(res.Alerts) != 3 {
		t.Fatalf("alerts: %+v", res.Alerts)
	}
	// firing first, critical before warning; the silenced one last
	if got := []string{res.Alerts[0].Fingerprint, res.Alerts[1].Fingerprint, res.Alerts[2].Fingerprint}; strings.Join(got, ",") != "a2,a1,a3" {
		t.Fatalf("order: %v", got)
	}
	if res.States[StateFiring] != 2 || res.States[StateSilenced] != 1 {
		t.Fatalf("states: %v", res.States)
	}
	a1 := res.Alerts[1]
	if a1.Summary != "cart restarts" || a1.Labels["namespace"] != "shop" || a1.Labels["__private"] != "" || a1.Labels["alertname"] != "" || a1.Receivers[0] != "slack" {
		t.Fatalf("alert: %+v", a1)
	}
	if len(res.Silences) != 1 || res.Silences[0].ID != "s-alpha" || res.Silences[0].Comment != "nightly batch" ||
		strings.Join(res.Silences[0].Matchers, " ") != `namespace="batch" alertname=~"Pod.*"` {
		t.Fatalf("silences: %+v", res.Silences)
	}
	if res.ByName[0] != (NameCount{Name: "PodCrashLooping", Severity: "warning", Count: 2}) {
		t.Fatalf("by name: %+v", res.ByName)
	}
}

func TestListStatesAndFilters(t *testing.T) {
	s, seen := fakeAM(t, sampleAlerts, sampleSilences)
	res, err := s.List(context.Background(), "alpha", Query{State: StateSilenced})
	if err != nil || len(res.Alerts) != 1 || res.Alerts[0].Fingerprint != "a3" || res.States[StateFiring] != 2 {
		t.Fatalf("silenced: %+v %v", res, err)
	}
	// the caller's values become quoted matchers; a cluster label the caller names gives way to the cluster's
	res, err = s.List(context.Background(), "alpha", Query{State: StateFiring, AlertName: "PodCrashLooping", Labels: map[string]string{"cluster": "eks-beta", "team": `a"b\c`}})
	if err != nil {
		t.Fatal(err)
	}
	f := (*seen)[len(*seen)-1]["filter"]
	if strings.Join(f, " ") != `alertname="PodCrashLooping" cluster="eks-alpha" team="a\"b\\c"` {
		t.Fatalf("filter: %v", f)
	}
	if len(res.Alerts) != 0 { // no alert has that team
		t.Fatalf("filtered: %+v", res.Alerts)
	}
	res, _ = s.List(context.Background(), "beta", Query{})
	if len(res.Alerts) != 1 || res.Alerts[0].Fingerprint != "b1" || len(res.Silences) != 1 || res.Silences[0].ID != "s-beta" {
		t.Fatalf("beta: %+v", res)
	}
}

func TestListCutsAndRefuses(t *testing.T) {
	s, _ := fakeAM(t, sampleAlerts, sampleSilences)
	s.cfg.MaxAlerts = 1
	res, err := s.List(context.Background(), "alpha", Query{})
	if err != nil || len(res.Alerts) != 1 || res.Total != 3 || !res.Truncated {
		t.Fatalf("cut: %+v %v", res, err)
	}
	if _, err := s.List(context.Background(), "gamma", Query{}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("unlisted cluster: %v", err)
	}
	for _, q := range []Query{
		{State: "pending"},
		{Labels: map[string]string{"bad-name": "x"}},
		{Labels: map[string]string{"team": "a\nb"}},
		{AlertName: strings.Repeat("x", 201)},
	} {
		if _, err := s.List(context.Background(), "alpha", q); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("%+v: %v", q, err)
		}
	}
	s.cfg.URL += "/nowhere"
	if _, err := s.List(context.Background(), "alpha", Query{}); !errors.Is(err, ErrNotServed) {
		t.Fatalf("404: %v", err)
	}
	s.cfg.AuthHeader = "Bearer wrong"
	s.cfg.URL = strings.TrimSuffix(s.cfg.URL, "/nowhere")
	var se *StoreError
	if _, err := s.List(context.Background(), "alpha", Query{}); !errors.As(err, &se) || se.Status != http.StatusUnauthorized {
		t.Fatalf("401: %v", err)
	}
}

func TestOneClusterStoreAndValidate(t *testing.T) {
	s, seen := fakeAM(t, sampleAlerts, sampleSilences)
	s.cfg.Clusters = map[string]string{"only": ""}
	res, err := s.List(context.Background(), "only", Query{})
	if err != nil || len((*seen)[0]["filter"]) != 0 || res.Total != 5 {
		t.Fatalf("one-cluster store: %d alerts, filter %v, %v", res.Total, (*seen)[0]["filter"], err)
	}
	base := Config{Enabled: true, URL: "http://am:9093", ClusterLabel: "cluster", MaxAlerts: 100, Timeout: time.Second, PerUserPerMinute: 1}
	for name, mutate := range map[string]func(*Config){
		"no url":                    func(c *Config) { c.URL = "am:9093" },
		"bad label":                 func(c *Config) { c.ClusterLabel = "k8s.cluster" },
		"no clusters":               func(c *Config) { c.Clusters = nil },
		"empty value of two":        func(c *Config) { c.Clusters = map[string]string{"a": "", "b": "x"} },
		"no timeout":                func(c *Config) { c.Timeout = 0 },
		"too many alerts":           func(c *Config) { c.MaxAlerts = 501 },
		"no per-user budget at all": func(c *Config) { c.PerUserPerMinute = 0 },
	} {
		c := base
		c.Clusters = map[string]string{"a": "x"}
		mutate(&c)
		if c.Validate() == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	c := base
	c.Clusters = map[string]string{"a": ""}
	if err := c.Validate(); err != nil {
		t.Fatalf("one cluster with an empty value: %v", err)
	}
}
