package k8s

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

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
