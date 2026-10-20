package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// amWrites is an Alertmanager that takes silence writes and keeps what it was sent.
type amWrites struct {
	posted  []map[string]interface{}
	deleted []string
	filters [][]string
}

const storedSilences = `[
 {"id":"s-alpha","matchers":[{"name":"alertname","value":"PodCrashLooping","isRegex":false,"isEqual":true},{"name":"cluster","value":"eks-alpha","isRegex":false,"isEqual":true}],
  "createdBy":"a@x","comment":"deploy","startsAt":"2026-10-19T04:00:00Z","endsAt":"2026-10-19T08:00:00Z","status":{"state":"active"}},
 {"id":"s-beta","matchers":[{"name":"alertname","value":"NodeDiskFull","isRegex":false,"isEqual":true},{"name":"cluster","value":"eks-beta","isRegex":false,"isEqual":true}],
  "createdBy":"b@x","comment":"beta","startsAt":"2026-10-19T03:00:00Z","endsAt":"2026-10-19T09:00:00Z","status":{"state":"active"}},
 {"id":"s-regex","matchers":[{"name":"alertname","value":"X","isRegex":false,"isEqual":true},{"name":"cluster","value":"eks-alpha|eks-beta","isRegex":true,"isEqual":true}],
  "createdBy":"c@x","comment":"both","startsAt":"2026-10-19T03:00:00Z","endsAt":"2026-10-19T09:00:00Z","status":{"state":"active"}},
 {"id":"s-dot","matchers":[{"name":"alertname","value":"Z","isRegex":false,"isEqual":true},{"name":"cluster","value":"eks.alpha","isRegex":true,"isEqual":true}],
  "createdBy":"e@x","comment":"dot","startsAt":"2026-10-19T03:00:00Z","endsAt":"2026-10-19T09:00:00Z","status":{"state":"active"}},
 {"id":"s-old","matchers":[{"name":"alertname","value":"Y","isRegex":false,"isEqual":true},{"name":"cluster","value":"eks-alpha","isRegex":false,"isEqual":true}],
  "createdBy":"d@x","comment":"gone","startsAt":"2026-10-18T03:00:00Z","endsAt":"2026-10-18T04:00:00Z","status":{"state":"expired"}}
]`

func writesAM(t *testing.T, clusters map[string]string, silencesOn bool) (*Store, *amWrites) {
	t.Helper()
	w := &amWrites{}
	byID := map[string]json.RawMessage{}
	var list []json.RawMessage
	_ = json.Unmarshal([]byte(storedSilences), &list)
	for _, raw := range list {
		var head struct{ ID string }
		_ = json.Unmarshal(raw, &head)
		byID[head.ID] = raw
	}
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/silences":
			_, _ = rw.Write([]byte(storedSilences))
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v2/silence/"):
			raw, ok := byID[strings.TrimPrefix(r.URL.Path, "/api/v2/silence/")]
			if !ok {
				rw.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = rw.Write(raw)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v2/silence/"):
			w.deleted = append(w.deleted, strings.TrimPrefix(r.URL.Path, "/api/v2/silence/"))
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/silences":
			body, _ := io.ReadAll(r.Body)
			var got map[string]interface{}
			_ = json.Unmarshal(body, &got)
			w.posted = append(w.posted, got)
			_, _ = rw.Write([]byte(`{"silenceID":"new-1"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/alerts":
			w.filters = append(w.filters, r.URL.Query()["filter"])
			_, _ = rw.Write([]byte(sampleAlerts)) // ignores the filter: the store checks again
		default:
			rw.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	s, err := New(Config{Enabled: true, URL: srv.URL, ClusterLabel: "cluster", Clusters: clusters, MaxAlerts: 100, Timeout: 5 * time.Second,
		PerUserPerMinute: 5, SilencesEnabled: silencesOn, SilenceMaxDuration: 168 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	return s, w
}

var twoClusters = map[string]string{"alpha": "eks-alpha", "beta": "eks-beta"}

func eq(name, value string) Matcher { return Matcher{Name: name, Value: value, IsEqual: true} }

func TestConditionsAUserMaySet(t *testing.T) {
	s, _ := writesAM(t, twoClusters, true)
	ok := [][]Matcher{
		{eq("alertname", "PodCrashLooping")},
		{eq("alertname", "PodCrashLooping"), {Name: "namespace", Value: "shop|batch", IsRegex: true, IsEqual: true}},
		{{Name: "pod", Value: "", IsEqual: false}}, // pod != "" — an empty label does not satisfy it
	}
	for _, ms := range ok {
		if err := s.CheckMatchers(ms); err != nil {
			t.Errorf("%v: %v", ms, err)
		}
	}
	bad := map[string][]Matcher{
		"none":           nil,
		"eleven":         make([]Matcher, 11),
		"cluster label":  {eq("alertname", "X"), eq("cluster", "eks-beta")},
		"bad name":       {eq("alert-name", "X")},
		"newline":        {eq("alertname", "X\ny")},
		"long":           {eq("alertname", strings.Repeat("x", 201))},
		"bad regex":      {{Name: "alertname", Value: "(", IsRegex: true, IsEqual: true}},
		"matches empty":  {{Name: "alertname", Value: ".*", IsRegex: true, IsEqual: true}},
		"only negatives": {{Name: "alertname", Value: "Watchdog", IsEqual: false}},
		"empty equals":   {eq("alertname", "")},
	}
	for name, ms := range bad {
		if err := s.CheckMatchers(ms); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: want invalid, got %v", name, err)
		}
	}
}

func TestASilenceCarriesTheClusterCondition(t *testing.T) {
	s, w := writesAM(t, twoClusters, true)
	now := time.Date(2026, 10, 20, 5, 0, 0, 0, time.UTC)
	id, ms, err := s.Create(context.Background(), "alpha", SilenceRequest{Matchers: []Matcher{eq("alertname", "PodCrashLooping")}, Duration: 2 * time.Hour, Comment: " deploy window "}, "me@x", now)
	if err != nil || id != "new-1" {
		t.Fatalf("create: %q %v", id, err)
	}
	if len(ms) != 2 || ms[1] != eq("cluster", "eks-alpha") {
		t.Fatalf("matchers %v", ms)
	}
	got := w.posted[0]
	if got["createdBy"] != "me@x" || got["comment"] != "deploy window" || got["startsAt"] != "2026-10-20T05:00:00Z" || got["endsAt"] != "2026-10-20T07:00:00Z" {
		t.Fatalf("posted %v", got)
	}
	if len(got["matchers"].([]interface{})) != 2 {
		t.Fatalf("posted matchers %v", got["matchers"])
	}

	// a store of one cluster: every alert is that cluster's, nothing to add
	one, w1 := writesAM(t, map[string]string{"only": ""}, true)
	if _, ms, err := one.Create(context.Background(), "only", SilenceRequest{Matchers: []Matcher{eq("alertname", "X")}, Duration: time.Hour, Comment: "c"}, "me@x", now); err != nil || len(ms) != 1 {
		t.Fatalf("one cluster: %v %v", ms, err)
	}
	if len(w1.posted) != 1 {
		t.Fatal("not posted")
	}
}

func TestACreateIsRefusedBeforeTheStore(t *testing.T) {
	now := time.Now()
	ok := []Matcher{eq("alertname", "X")}
	off, w := writesAM(t, twoClusters, false)
	if _, _, err := off.Create(context.Background(), "alpha", SilenceRequest{Matchers: ok, Duration: time.Hour, Comment: "c"}, "me@x", now); !errors.Is(err, ErrSilencesOff) {
		t.Fatalf("off: %v", err)
	}
	s, w2 := writesAM(t, twoClusters, true)
	cases := map[string]SilenceRequest{
		"short":      {Matchers: ok, Duration: 30 * time.Second, Comment: "c"},
		"long":       {Matchers: ok, Duration: 169 * time.Hour, Comment: "c"},
		"no comment": {Matchers: ok, Duration: time.Hour, Comment: "  "},
		"comment":    {Matchers: ok, Duration: time.Hour, Comment: strings.Repeat("x", 501)},
		"matchers":   {Matchers: []Matcher{eq("cluster", "eks-beta")}, Duration: time.Hour, Comment: "c"},
	}
	for name, req := range cases {
		if _, _, err := s.Create(context.Background(), "alpha", req, "me@x", now); !errors.Is(err, ErrInvalidRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, _, err := s.Create(context.Background(), "gamma", SilenceRequest{Matchers: ok, Duration: time.Hour, Comment: "c"}, "me@x", now); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("unknown cluster: %v", err)
	}
	if len(w.posted)+len(w2.posted) != 0 {
		t.Fatal("a refused silence reached the store")
	}
}

func TestOnlyTheClustersOwnSilencesAreListedAndExpired(t *testing.T) {
	s, w := writesAM(t, twoClusters, true)
	got, err := s.Silences(context.Background(), "alpha")
	if err != nil || len(got) != 1 || got[0].ID != "s-alpha" || got[0].Matchers[1] != `cluster="eks-alpha"` {
		t.Fatalf("alpha silences %v %v", got, err)
	}
	for _, sid := range []string{"s-beta", "s-regex", "missing"} {
		if _, err := s.Expire(context.Background(), "alpha", sid); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v", sid, err)
		}
	}
	if _, err := s.Expire(context.Background(), "alpha", "../silences"); !errors.Is(err, ErrInvalidRequest) {
		t.Errorf("path: %v", err)
	}
	sl, err := s.Expire(context.Background(), "alpha", "s-alpha")
	if err != nil || sl.Comment != "deploy" {
		t.Fatalf("expire: %v %v", sl, err)
	}
	if strings.Join(w.deleted, ",") != "s-alpha" {
		t.Fatalf("deleted %v", w.deleted)
	}
	off, _ := writesAM(t, twoClusters, false)
	if _, err := off.Expire(context.Background(), "alpha", "s-alpha"); !errors.Is(err, ErrSilencesOff) {
		t.Errorf("off: %v", err)
	}
	// cluster=~"eks.alpha" also mutes "eksXalpha": a regex on the cluster label is not this cluster's, even when its
	// text is the cluster's value
	dot, _ := writesAM(t, map[string]string{"dot": "eks.alpha", "x": "eksXalpha"}, true)
	if _, err := dot.Expire(context.Background(), "dot", "s-dot"); !errors.Is(err, ErrNotFound) {
		t.Errorf("regex cluster condition: %v", err)
	}
}

func TestThePreviewAsksWithTheClusterAndChecksAgain(t *testing.T) {
	s, w := writesAM(t, twoClusters, true)
	res, err := s.Preview(context.Background(), "alpha", []Matcher{eq("alertname", "NodeDiskFull")})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(w.filters[0], " ") != `alertname="NodeDiskFull" cluster="eks-alpha"` {
		t.Fatalf("filter %v", w.filters[0])
	}
	if res.Total != 1 || res.Alerts[0].Fingerprint != "a2" { // b1 (eks-beta) came back and was dropped
		t.Fatalf("preview %+v", res)
	}
	if _, err := s.Preview(context.Background(), "alpha", []Matcher{eq("cluster", "eks-beta")}); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("cluster condition: %v", err)
	}
}

// Random condition lists — names from a pool with the cluster label, look-alikes and junk, values with quotes,
// backslashes and regex — never get a silence to the store without exactly this cluster's condition, nor with a
// second condition on the cluster label.
func TestNoConditionListGetsPastTheClusterCondition(t *testing.T) {
	s, w := writesAM(t, twoClusters, true)
	names := []string{"cluster", "Cluster", "cluster_", "_cluster", "alertname", "namespace", "pod", "clu ster", "cluster\x00", "", "severity", "__name__"}
	values := []string{"eks-alpha", "eks-beta", ".*", "eks-.*", `eks-alpha"`, `\`, "", "x|eks-beta", "(", "PodCrashLooping", "é"}
	rng := rand.New(rand.NewSource(20261020))
	const runs = 5000
	created := 0
	for i := 0; i < runs; i++ {
		ms := make([]Matcher, 1+rng.Intn(4))
		for j := range ms {
			ms[j] = Matcher{Name: names[rng.Intn(len(names))], Value: values[rng.Intn(len(values))], IsRegex: rng.Intn(3) == 0, IsEqual: rng.Intn(4) != 0}
		}
		before := len(w.posted)
		_, _, err := s.Create(context.Background(), "alpha", SilenceRequest{Matchers: ms, Duration: time.Hour, Comment: "c"}, "me@x", time.Now())
		if err != nil {
			if len(w.posted) != before {
				t.Fatalf("refused but posted: %v", ms)
			}
			continue
		}
		created++
		posted := w.posted[len(w.posted)-1]["matchers"].([]interface{})
		onCluster := 0
		for _, raw := range posted {
			m := raw.(map[string]interface{})
			if m["name"] == "cluster" {
				onCluster++
				if m["value"] != "eks-alpha" || m["isRegex"] != false || m["isEqual"] != true {
					t.Fatalf("cluster condition %v from %v", m, ms)
				}
			}
		}
		if onCluster != 1 {
			t.Fatalf("%d cluster conditions from %v", onCluster, ms)
		}
	}
	if created == 0 || created == runs {
		t.Fatalf("created %d of %d: the pool should give both outcomes", created, runs)
	}
	t.Logf("%d of %d random condition lists were created, each with exactly cluster=\"eks-alpha\"", created, runs)
}
