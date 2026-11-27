package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/prometheus/prometheus/promql/parser"
)

// gpuSeriesService is a Service whose store holds each DCGM series (metric → UUID → value) with the labels the
// exporter writes, and answers each query as Prometheus does (dcgmStoreService): a metric it does not hold has none.
func gpuSeriesService(t *testing.T, series map[string]map[string]float64) *Service {
	t.Helper()
	rows := []dcgmRow{}
	for name, byUUID := range series {
		for uuid, value := range byUUID {
			rows = append(rows, dcgmRow{map[string]string{"__name__": name, "UUID": uuid, "gpu": "0", "hostname": "n1"}, value})
		}
	}
	return dcgmStoreService(t, rows, "")
}

// dcgmStoreService is a Service whose store holds rows and answers each instant query by evaluating it (evalDCGM). With
// cluster set the store is shared, and the service reads the series whose cluster label is that.
func dcgmStoreService(t *testing.T, rows []dcgmRow, cluster string) *Service {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "")
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := []map[string]interface{}{}
		expr, err := promParser.ParseExpr(r.URL.Query().Get("query"))
		if err != nil {
			t.Errorf("query %q: %v", r.URL.Query().Get("query"), err)
		} else {
			for _, row := range evalDCGM(t, expr, rows) {
				result = append(result, map[string]interface{}{"metric": row.labels, "value": []interface{}{1, strconv.FormatFloat(row.value, 'f', -1, 64)}})
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": map[string]interface{}{"resultType": "vector", "result": result}})
	}))
	t.Cleanup(srv.Close)
	s := &Service{promQ: newPromQueryCache(0)}
	s.defaultBundle.Store(&clientBundle{prom: &promCache{}, promExt: &promExternal{baseURL: srv.URL, labelValue: cluster}})
	return s
}

// dcgmRow is a series of the stand-in store: its labels, the metric name as __name__, and its value.
type dcgmRow struct {
	labels map[string]string
	value  float64
}

// evalDCGM evaluates expr over rows as Prometheus does, for the expressions GetGPUMetrics sends: a selector, a
// parenthesis, * or / by a number (which drops the name), and or without on or ignoring (the left side's series, then
// those of the right side whose labels but the name no left series has). Any other expression fails the test.
func evalDCGM(t *testing.T, expr parser.Expr, rows []dcgmRow) []dcgmRow {
	switch e := expr.(type) {
	case *parser.VectorSelector:
		out := []dcgmRow{}
	next:
		for _, r := range rows {
			for _, m := range e.LabelMatchers {
				if !m.Matches(r.labels[m.Name]) {
					continue next
				}
			}
			out = append(out, r)
		}
		return out
	case *parser.ParenExpr:
		return evalDCGM(t, e.Expr, rows)
	case *parser.BinaryExpr:
		n, byNumber := e.RHS.(*parser.NumberLiteral)
		switch {
		case e.Op == parser.LOR && (e.VectorMatching == nil || (!e.VectorMatching.On && len(e.VectorMatching.MatchingLabels) == 0)):
			left := evalDCGM(t, e.LHS, rows)
			held := map[string]bool{}
			for _, r := range left {
				held[labelsButName(r.labels)] = true
			}
			out := append([]dcgmRow{}, left...)
			for _, r := range evalDCGM(t, e.RHS, rows) {
				if !held[labelsButName(r.labels)] {
					out = append(out, r)
				}
			}
			return out
		case byNumber && (e.Op == parser.MUL || e.Op == parser.DIV):
			out := []dcgmRow{}
			for _, r := range evalDCGM(t, e.LHS, rows) {
				l := map[string]string{}
				for k, v := range r.labels {
					if k != "__name__" {
						l[k] = v
					}
				}
				v := r.value * n.Val
				if e.Op == parser.DIV {
					v = r.value / n.Val
				}
				out = append(out, dcgmRow{l, v})
			}
			return out
		}
	}
	t.Errorf("the stand-in store does not evaluate %s", expr)
	return nil
}

// labelsButName is what or matches two series on: their labels but the metric name.
func labelsButName(l map[string]string) string {
	var b strings.Builder
	for _, k := range sortedKeys(l) {
		if k != "__name__" {
			fmt.Fprintf(&b, "%s=%q,", k, l[k])
		}
	}
	return b.String()
}

// wantNumbers holds each key to its number, nil being a value the answer must not have: null, not zero.
func wantNumbers(t *testing.T, where string, got map[string]interface{}, want map[string]interface{}) {
	t.Helper()
	for key, w := range want {
		v, present := got[key]
		if !present {
			t.Errorf("%s: %s is left out, want %v", where, key, w)
			continue
		}
		if w == nil {
			if v != nil {
				t.Errorf("%s: %s = %v, want null: this series was not read", where, key, v)
			}
			continue
		}
		f, ok := v.(float64)
		if !ok || math.Abs(f-w.(float64)) > 1e-9 {
			t.Errorf("%s: %s = %v, want %v", where, key, v, w)
		}
	}
}

// A series a GPU does not report is not read, which is not 0: its value is null, a real 0 stays 0, and the averages and
// totals are of the GPUs that have the value, as Prometheus's avg() and a division of two series are.
func TestGPUMetrics_ASeriesAGPUDoesNotReportIsNullNotZero(t *testing.T) {
	s := gpuSeriesService(t, map[string]map[string]float64{
		"DCGM_FI_DEV_GPU_UTIL":    {"GPU-full": 80, "GPU-no-used": 40, "GPU-idle": 0},
		"DCGM_FI_DEV_FB_USED":     {"GPU-full": 1000, "GPU-no-util": 500, "GPU-idle": 0},
		"DCGM_FI_DEV_FB_FREE":     {"GPU-full": 3000, "GPU-no-used": 2000, "GPU-idle": 8000},
		"DCGM_FI_DEV_MEMORY_TEMP": {"GPU-full": 50},
	})
	got, err := s.GetGPUMetrics(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got["gpu_count"] != 4 {
		t.Fatalf("gpu_count = %v: a GPU with any series is a GPU", got["gpu_count"])
	}
	wantNumbers(t, "the totals", got, map[string]interface{}{
		"avg_gpu_util":         40.0, // (80 + 40 + 0) / 3, not / 4
		"total_memory_used_mb": 1000.0,
		"total_memory_free_mb": 11000.0,
		"total_memory_mb":      12000.0,
		"avg_memory_util":      1000.0 / 12000.0 * 100,
	})
	rows := map[string]map[string]interface{}{}
	for _, g := range got["gpus"].([]map[string]interface{}) {
		rows[g["uuid"].(string)] = g
	}
	for uuid, want := range map[string]map[string]interface{}{
		"GPU-full":    {"gpu_util": 80.0, "memory_used_mb": 1000.0, "memory_free_mb": 3000.0, "memory_total_mb": 4000.0, "memory_util_percent": 25.0, "memory_temp": 50.0},
		"GPU-no-util": {"gpu_util": nil, "memory_used_mb": 500.0, "memory_free_mb": nil, "memory_total_mb": nil, "memory_util_percent": nil, "memory_temp": nil},
		"GPU-no-used": {"gpu_util": 40.0, "memory_used_mb": nil, "memory_free_mb": 2000.0, "memory_total_mb": nil, "memory_util_percent": nil, "memory_temp": nil},
		"GPU-idle":    {"gpu_util": 0.0, "memory_used_mb": 0.0, "memory_free_mb": 8000.0, "memory_total_mb": 8000.0, "memory_util_percent": 0.0, "memory_temp": nil},
	} {
		wantNumbers(t, uuid, rows[uuid], want)
	}
}

// With no GPU to average, the averages and totals are not 0 either.
func TestGPUMetrics_NothingToAverageIsNullNotZero(t *testing.T) {
	onlyUtil := map[string]map[string]float64{"DCGM_FI_DEV_GPU_UTIL": {"GPU-a": 70}}
	onlyMemory := map[string]map[string]float64{"DCGM_FI_DEV_FB_USED": {"GPU-a": 1024}, "DCGM_FI_DEV_FB_FREE": {"GPU-a": 3072}}
	for _, c := range []struct {
		title  string
		series map[string]map[string]float64
		count  int
		want   map[string]interface{}
	}{
		{"no series at all", nil, 0, map[string]interface{}{"avg_gpu_util": nil, "avg_memory_util": nil, "total_memory_used_mb": nil, "total_memory_free_mb": nil, "total_memory_mb": nil}},
		{"utilization only", onlyUtil, 1, map[string]interface{}{"avg_gpu_util": 70.0, "avg_memory_util": nil, "total_memory_used_mb": nil, "total_memory_free_mb": nil, "total_memory_mb": nil}},
		{"memory only", onlyMemory, 1, map[string]interface{}{"avg_gpu_util": nil, "avg_memory_util": 25.0, "total_memory_used_mb": 1024.0, "total_memory_free_mb": 3072.0, "total_memory_mb": 4096.0}},
	} {
		t.Run(c.title, func(t *testing.T) {
			got, err := gpuSeriesService(t, c.series).GetGPUMetrics(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if got["available"] != true || got["gpu_count"] != c.count {
				t.Fatalf("available %v, gpu_count %v, want %d", got["available"], got["gpu_count"], c.count)
			}
			wantNumbers(t, c.title, got, c.want)
		})
	}
}

// A GPU reporting 0 of 0 has no percent to give, whatever it reports of its utilization.
func TestGPUMetrics_ZeroOfZeroMemoryHasNoPercent(t *testing.T) {
	got, err := gpuSeriesService(t, map[string]map[string]float64{
		"DCGM_FI_DEV_GPU_UTIL": {"GPU-a": 10},
		"DCGM_FI_DEV_FB_USED":  {"GPU-a": 0},
		"DCGM_FI_DEV_FB_FREE":  {"GPU-a": 0},
	}).GetGPUMetrics(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	row := got["gpus"].([]map[string]interface{})[0]
	wantNumbers(t, "GPU-a", row, map[string]interface{}{"gpu_util": 10.0, "memory_total_mb": 0.0, "memory_util_percent": nil})
	wantNumbers(t, "the totals", got, map[string]interface{}{"avg_memory_util": nil})
}

// A store that refuses the GPU queries is an error, not "no GPUs": the page said available with 0 GPUs to a caller
// the store refused. A store that answers gives each GPU's numbers.
func TestGPUMetrics_ARefusedQueryIsAnError(t *testing.T) {
	refused := storeService(t, &fakeStore{code: http.StatusForbidden}, "")
	if got, err := refused.GetGPUMetrics(context.Background()); err == nil || !strings.Contains(err.Error(), "GPU metric") {
		t.Fatalf("refused store: %v %v", got, err)
	}

	gpu := `{"resultType":"vector","result":[{"metric":{"UUID":"GPU-1","gpu":"0","Hostname":"n1","exported_namespace":"ml","exported_pod":"train-0"},"value":[1,"%s"]}]}`
	f := &fakeStore{paths: map[string]string{"/api/v1/query": strings.Replace(gpu, "%s", "40", 1)}}
	got, err := storeService(t, f, "").GetGPUMetrics(context.Background())
	if err != nil || got["available"] != true || got["gpu_count"] != 1 {
		t.Fatalf("answering store: %v %v", got, err)
	}
}

// dcgm-exporter 4.9.0 writes 4.8.4's series under DCGM 4.7's names (its etc/default-counters.csv): utilization a 0 to
// 1 ratio where it was a percent, memory in bytes where it was MiB, the temperature in °C as before. An exporter
// writing the old names, the new ones, both, or the new ones on some nodes only gives the answer of the old names, and
// the screens show the same; with the old names only the answer is their values as they are.
func TestGPUMetrics_TheNamesBeforeAndSinceDCGMExporter490GiveTheSameNumbers(t *testing.T) {
	type gpu struct {
		uuid, host             string
		util, used, free, temp float64
	}
	gpus := []gpu{
		{"GPU-a", "n1", 7, 1000, 3000, 50}, // 0.07 * 100 is 7.000000000000001
		{"GPU-b", "n1", 0, 0, 81050, 30},
		{"GPU-c", "n2", 58, 40000, 41920, 0},
		{"GPU-d", "n2", 100, 81919, 1, 85},
	}
	const mib = 1048576
	row := func(name string, g gpu, value float64, cluster string) dcgmRow {
		l := map[string]string{"__name__": name, "UUID": g.uuid, "gpu": "0", "device": "nvidia0", "modelName": "NVIDIA A100-SXM4-80GB",
			"hostname": g.host, "pod": "train-" + g.uuid, "namespace": "ml"}
		if cluster != "" {
			l["cluster"] = cluster
		}
		return dcgmRow{l, value}
	}
	before := func(g gpu, cluster string) []dcgmRow {
		return []dcgmRow{row("DCGM_FI_DEV_GPU_UTIL", g, g.util, cluster), row("DCGM_FI_DEV_FB_USED", g, g.used, cluster),
			row("DCGM_FI_DEV_FB_FREE", g, g.free, cluster), row("DCGM_FI_DEV_MEMORY_TEMP", g, g.temp, cluster)}
	}
	// 4.9.0 also writes the capacity (used, free and reserved), which the answer leaves out as it did
	since := func(g gpu, cluster string) []dcgmRow {
		return []dcgmRow{row("DCGM_FI_DEV_GPU_UTIL_RATIO", g, g.util/100, cluster), row("DCGM_FI_DEV_FB_USED_BYTES", g, g.used*mib, cluster),
			row("DCGM_FI_DEV_FB_FREE_BYTES", g, g.free*mib, cluster), row("DCGM_FI_DEV_MEMORY_TEMP_CELSIUS", g, g.temp, cluster),
			row("DCGM_FI_DEV_FB_CAPACITY_BYTES", g, (g.used+g.free+1920)*mib, cluster)}
	}
	of := func(rowsOf func(gpu, string) []dcgmRow, cluster string, gs ...gpu) []dcgmRow {
		rows := []dcgmRow{}
		for _, g := range gs {
			rows = append(rows, rowsOf(g, cluster)...)
		}
		return rows
	}
	answer := func(t *testing.T, rows []dcgmRow, cluster string) map[string]interface{} {
		t.Helper()
		got, err := dcgmStoreService(t, rows, cluster).GetGPUMetrics(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	// what the screens draw (gpuNumbers.ts gpuPercentText, RealtimeMetricsSection): percents rounded, GiB to a tenth
	shown := func(a map[string]interface{}) []string {
		pct := func(v interface{}) string {
			if v == nil {
				return "-"
			}
			return fmt.Sprintf("%v%%", math.Floor(v.(float64)+0.5))
		}
		gib := func(v interface{}) string {
			if v == nil {
				return "-"
			}
			return strconv.FormatFloat(v.(float64)/1024, 'f', 1, 64) + " GiB"
		}
		out := []string{fmt.Sprint(a["gpu_count"]), pct(a["avg_gpu_util"]), pct(a["avg_memory_util"]), gib(a["total_memory_used_mb"]), gib(a["total_memory_mb"])}
		for _, g := range a["gpus"].([]map[string]interface{}) {
			out = append(out, fmt.Sprintf("%s %s %s/%s core %s mem %s %v°C", g["hostname"], g["uuid"], g["exported_namespace"], g["exported_pod"],
				pct(g["gpu_util"]), pct(g["memory_util_percent"]), g["memory_temp"]))
		}
		return out
	}
	numbers := []string{"gpu_util", "memory_used_mb", "memory_free_mb", "memory_total_mb", "memory_util_percent", "memory_temp"}

	want := answer(t, of(before, "", gpus...), "")
	t.Run("the old names are read as they are", func(t *testing.T) {
		rows := want["gpus"].([]map[string]interface{})
		if len(rows) != len(gpus) {
			t.Fatalf("%d GPUs, want %d", len(rows), len(gpus))
		}
		for i, g := range gpus {
			got := []interface{}{rows[i]["uuid"], rows[i]["gpu_util"], rows[i]["memory_used_mb"], rows[i]["memory_free_mb"], rows[i]["memory_temp"]}
			if exact := []interface{}{g.uuid, g.util, g.used, g.free, g.temp}; !reflect.DeepEqual(got, exact) {
				t.Errorf("%s: %v, want %v", g.uuid, got, exact)
			}
		}
		if want["avg_gpu_util"] != (7.0+0+58+100)/4 || want["total_memory_used_mb"] != 1000.0+0+40000+81919 {
			t.Errorf("totals %v %v", want["avg_gpu_util"], want["total_memory_used_mb"])
		}
	})

	for _, c := range []struct {
		title   string
		rows    []dcgmRow
		cluster string
	}{
		{"the 4.9.0 names", of(since, "", gpus...), ""},
		{"both names from one exporter", append(of(before, "", gpus...), of(since, "", gpus...)...), ""},
		{"the 4.9.0 names on one node", append(of(before, "", gpus[0], gpus[1]), of(since, "", gpus[2], gpus[3])...), ""},
		{"a shared store's cluster, both sides of or narrowed to it", append(append(of(before, "a", gpus[0], gpus[1]), of(since, "a", gpus[2], gpus[3])...),
			of(since, "b", gpu{"GPU-other", "n9", 90, 9, 9, 99})...), "a"},
	} {
		t.Run(c.title, func(t *testing.T) {
			got := answer(t, c.rows, c.cluster)
			if g, w := shown(got), shown(want); !reflect.DeepEqual(g, w) {
				t.Fatalf("the screens show\n%q\nwant\n%q", g, w)
			}
			wantNumbers(t, "the totals", got, map[string]interface{}{"avg_gpu_util": want["avg_gpu_util"], "avg_memory_util": want["avg_memory_util"],
				"total_memory_used_mb": want["total_memory_used_mb"], "total_memory_free_mb": want["total_memory_free_mb"], "total_memory_mb": want["total_memory_mb"]})
			for i, w := range want["gpus"].([]map[string]interface{}) {
				g := got["gpus"].([]map[string]interface{})[i]
				each := map[string]interface{}{}
				for _, key := range numbers {
					each[key] = w[key]
				}
				wantNumbers(t, w["uuid"].(string), g, each)
			}
		})
	}
}
