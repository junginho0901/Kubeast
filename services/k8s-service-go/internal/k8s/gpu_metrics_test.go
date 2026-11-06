package k8s

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// gpuSeriesService is a Service whose store answers each DCGM query with its series (metric → UUID → value) and any
// other query with none, as Prometheus answers for a metric it does not hold.
func gpuSeriesService(t *testing.T, series map[string]map[string]float64) *Service {
	t.Helper()
	t.Setenv("PROMETHEUS_ENABLED", "")
	t.Setenv("PROMETHEUS_CLUSTER_LABEL", "")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result := []map[string]interface{}{}
		for uuid, value := range series[r.URL.Query().Get("query")] {
			result = append(result, map[string]interface{}{
				"metric": map[string]string{"UUID": uuid, "gpu": "0", "hostname": "n1"},
				"value":  []interface{}{1, fmtFloat(value)},
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": map[string]interface{}{"resultType": "vector", "result": result}})
	}))
	t.Cleanup(srv.Close)
	s := &Service{promQ: newPromQueryCache(0)}
	s.defaultBundle.Store(&clientBundle{prom: &promCache{}, promExt: &promExternal{baseURL: srv.URL}})
	return s
}

func fmtFloat(v float64) string {
	b, _ := json.Marshal(v)
	return string(b)
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
