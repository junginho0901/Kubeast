package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// promValuesAPI is an API server whose Prometheus Service answers, through the API server proxy, every instant query
// with instant and every range query with ranged.
func promValuesAPI(t *testing.T, instant, ranged *string) *Handler {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "true")
	t.Setenv("PROMETHEUS_SERVICE", "monitoring/prometheus:9090")
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "")
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query":
			_, _ = w.Write([]byte(*instant))
		case "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query_range":
			_, _ = w.Write([]byte(*ranged))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
		}
	}))
	t.Cleanup(api.Close)
	return metricsHandler(t, api.URL)
}

// Prometheus answers NaN for 0/0 (a throttling ratio of a pod with no CPU periods, a quantile over no requests) and
// +Inf or -Inf for x/0. JSON holds neither: the whole answer was a 200 with no body, which the AI's prometheus_query read
// as "unreadable reply: unexpected end of JSON input" and a drawer as no Prometheus. The value is null, its series and
// every other series kept.
func TestPrometheusQueryGivesANaNOrInfiniteValueAsNullAndKeepsEverySeries(t *testing.T) {
	var instant, ranged string
	h := promValuesAPI(t, &instant, &ranged)
	everything := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}
	for i, value := range []string{`"NaN"`, `"+Inf"`, `"-Inf"`} {
		instant = `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"pod":"a"},"value":[1764140000,"0.25"]},{"metric":{"pod":"b"},"value":[1764140000,` + value + `]}]}}`
		// a new query each time: the service keeps the answer of the same query for a while
		q := fmt.Sprintf(`sum by (pod) (rate(container_cpu_cfs_throttled_periods_total[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total[5m])) + 0*%d`, i)
		w := httptest.NewRecorder()
		h.PrometheusQuery(w, logSearchRequestAs("/api/v1/prometheus/query?query="+url.QueryEscape(q), "c1", "", everything))
		want := `{"available":true,"results":[{"metric":{"pod":"a"},"value":0.25},{"metric":{"pod":"b"},"value":null}]}` + "\n"
		if w.Code != http.StatusOK || w.Body.String() != want {
			t.Errorf("%s: %d %q, want 200 %q", value, w.Code, w.Body.String(), want)
		}
	}
}

// A range point Prometheus answers as NaN or an infinity is left out (JSON holds neither, and the chart under an AI
// answer adds the points up); the series' other points stay, and a series with no point left is still listed.
func TestPrometheusQueryRangeLeavesOutANaNOrInfinitePointAndKeepsTheRest(t *testing.T) {
	var instant, ranged string
	h := promValuesAPI(t, &instant, &ranged)
	everything := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}
	for i, value := range []string{`"NaN"`, `"+Inf"`, `"-Inf"`} {
		ranged = `{"status":"success","data":{"resultType":"matrix","result":[` +
			`{"metric":{"pod":"a"},"values":[[1764140000,"0.25"],[1764140060,` + value + `],[1764140120,"0.5"]]},` +
			`{"metric":{"pod":"b"},"values":[[1764140000,` + value + `],[1764140060,` + value + `]]}]}}`
		q := fmt.Sprintf(`histogram_quantile(0.99, sum by (le, pod) (rate(http_request_duration_seconds_bucket[5m]))) + 0*%d`, i)
		w := httptest.NewRecorder()
		h.PrometheusQueryRange(w, logSearchRequestAs("/api/v1/prometheus/query_range?start=1764140000&end=1764140120&step=60&query="+url.QueryEscape(q), "c1", "", everything))
		want := `{"available":true,"results":[{"metric":{"pod":"a"},"points":[{"t":1764140000,"v":0.25},{"t":1764140120,"v":0.5}]},{"metric":{"pod":"b"},"points":[]}]}` + "\n"
		if w.Code != http.StatusOK || w.Body.String() != want {
			t.Errorf("%s: %d %q, want 200 %q", value, w.Code, w.Body.String(), want)
		}
		var reply struct {
			Results []map[string]json.RawMessage `json:"results"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil || len(reply.Results) != 2 {
			t.Errorf("%s: not readable as the AI's prometheus_query reads it: %v %+v", value, err, reply)
		}
	}
}
