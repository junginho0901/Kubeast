package handler_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// healthRegistry names no default cluster at start; once slow is set, naming it takes a while, as a database that
// answers slowly does.
type healthRegistry struct {
	blob string
	slow atomic.Int64 // nanoseconds the default takes; 0 is "none registered"
}

func (r *healthRegistry) List(context.Context) ([]cluster.Info, error) { return nil, nil }
func (r *healthRegistry) Get(_ context.Context, id cluster.ID) (*cluster.Info, error) {
	return &cluster.Info{ID: id, Mode: cluster.ModeExternal, KubeconfigBlob: r.blob}, nil
}
func (r *healthRegistry) Default(context.Context) (cluster.ID, error) {
	d := time.Duration(r.slow.Load())
	if d == 0 {
		return "", cluster.ErrNotFound
	}
	time.Sleep(d)
	return "c", nil
}

// slowAudit is an audit store whose status takes a while to read.
type slowAudit struct{ took time.Duration }

func (slowAudit) Write(context.Context, audit.Record) (int64, error) { return 1, nil }
func (a slowAudit) Status(ctx context.Context) audit.Status {
	select {
	case <-time.After(a.took):
		return audit.Status{Writer: "test", Ready: true}
	case <-ctx.Done():
		return audit.Status{Writer: "test"}
	}
}

func askHealth(t *testing.T, h *handler.Handler) (map[string]interface{}, time.Duration) {
	t.Helper()
	start := time.Now()
	w := httptest.NewRecorder()
	h.HealthCheck(w, httptest.NewRequest(http.MethodGet, "/health", nil))
	took := time.Since(start)
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("status %d body %s: %v", w.Code, w.Body, err)
	}
	return body, took
}

// /health answers inside the 2 s auth-service waits for it (CheckK8sServiceHealth): the cluster read and the audit
// status run side by side, a default cluster slow to find or a cluster that does not answer cost at most the wait, and a
// cluster answering in 1 s still reads connected.
func TestHealthAnswersInsideTheSetupWait(t *testing.T) {
	versionTakes := atomic.Int64{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/version" {
			http.NotFound(w, r)
			return
		}
		select {
		case <-time.After(time.Duration(versionTakes.Load())):
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"major":"1","minor":"35","gitVersion":"v1.35.0"}`))
	}))
	defer api.Close()
	reg := &healthRegistry{blob: strings.Replace(standInKubeconfig, "SERVER", api.URL, 1)}
	// ask builds a Service as main.go does, asks /health once and waits for the read it started, which goes on past the
	// answer, before the next Service sets the package's options again.
	ask := func(prepare func()) (map[string]interface{}, time.Duration) {
		svc, err := k8s.NewService(context.Background(), reg, false, cache.New("", 0, 0, ""), k8s.ServiceOptions{})
		if err != nil {
			t.Fatal(err)
		}
		prepare()
		body, took := askHealth(t, handler.New(svc, config.Config{}, slowAudit{took: 400 * time.Millisecond}))
		_ = svc.HealthCheck(context.Background())
		return body, took
	}

	// none registered at start: the default is found on the first /health, and takes 3 s to find
	body, took := ask(func() { reg.slow.Store(int64(3 * time.Second)) })
	if took > 1900*time.Millisecond || body["kubernetes"] != "disconnected" {
		t.Errorf("default cluster slow to find: %v in %v, want disconnected within 1.9 s", body["kubernetes"], took.Round(time.Millisecond))
	}
	if a, _ := body["audit"].(map[string]interface{}); a["ready"] != true {
		t.Errorf("audit status %v, want the store's answer read beside the cluster's", body["audit"])
	}

	reg.slow.Store(int64(time.Millisecond))
	body, took = ask(func() { versionTakes.Store(int64(5 * time.Second)) }) // an API server that does not answer
	if took > 1900*time.Millisecond || body["kubernetes"] != "disconnected" {
		t.Errorf("API server not answering: %v in %v, want disconnected within 1.9 s", body["kubernetes"], took.Round(time.Millisecond))
	}

	body, took = ask(func() { versionTakes.Store(int64(time.Second)) }) // a slow but answering API server
	if took > 1900*time.Millisecond || body["kubernetes"] != "connected" {
		t.Errorf("API server answering in 1 s: %v in %v, want connected within 1.9 s", body["kubernetes"], took.Round(time.Millisecond))
	}
}
