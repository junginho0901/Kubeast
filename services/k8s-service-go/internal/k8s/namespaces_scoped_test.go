package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// namespaceAPI answers GET /api/v1/namespaces/<name> after a pause, refusing or missing the names it is told, and
// counts how many it answers at once.
type namespaceAPI struct {
	pause   time.Duration
	refused map[string]int // name → status
	release chan struct{}  // when set, each GET waits for it

	mu            sync.Mutex
	running, most int
	asked         int
}

func (a *namespaceAPI) service(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, ok := strings.CutPrefix(r.URL.Path, "/api/v1/namespaces/")
		if !ok || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		a.mu.Lock()
		a.asked++
		a.running++
		if a.running > a.most {
			a.most = a.running
		}
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			a.running--
			a.mu.Unlock()
		}()
		if a.release != nil {
			select {
			case <-a.release:
			case <-r.Context().Done():
				return
			}
		}
		time.Sleep(a.pause)
		if status := a.refused[name]; status != 0 {
			reason := metav1.StatusReasonForbidden
			if status == http.StatusNotFound {
				reason = metav1.StatusReasonNotFound
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: metav1.StatusFailure, Code: int32(status), Reason: reason})
			return
		}
		ns := corev1.Namespace{
			TypeMeta:   metav1.TypeMeta{Kind: "Namespace", APIVersion: "v1"},
			ObjectMeta: metav1.ObjectMeta{Name: name, Labels: map[string]string{"team": name}, CreationTimestamp: metav1.NewTime(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))},
			Status:     corev1.NamespaceStatus{Phase: corev1.NamespaceTerminating},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ns)
	}))
	t.Cleanup(srv.Close)
	cfg := &rest.Config{Host: srv.URL, QPS: -1}
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return auth.ImpersonationRoundTripper(rt, "default") })
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

func scopedCaller(scope []string) context.Context {
	return auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "scoped", Email: "scoped@example.com", Namespaces: map[string][]string{"default": scope}})
}

func scopeOf(n int) []string {
	scope := make([]string, n)
	for i := range scope {
		scope[i] = fmt.Sprintf("ns-%02d", i)
	}
	return scope
}

// A grant of 20 namespaces reads them side by side, eight at a time, and lists them in the grant's order.
func TestScopedNamespacesAreReadSideBySide(t *testing.T) {
	api := &namespaceAPI{pause: 40 * time.Millisecond}
	s := api.service(t)
	scope := scopeOf(20)
	got, err := s.GetNamespaces(scopedCaller(scope))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(scope) {
		t.Fatalf("%d rows, want %d", len(got), len(scope))
	}
	for i, row := range got {
		labels, _ := row["labels"].(map[string]string)
		if row["name"] != scope[i] || row["status"] != "Terminating" || row["created_at"] == "" || labels["team"] != scope[i] {
			t.Errorf("row %d = %v, want %s read from the cluster", i, row, scope[i])
		}
	}
	api.mu.Lock()
	defer api.mu.Unlock()
	if api.most != listFanOutWorkers {
		t.Errorf("at most %d namespaces were read at once, want %d", api.most, listFanOutWorkers)
	}
}

// A namespace the cluster refuses or does not have keeps its row with what the grant says, as before.
func TestScopedNamespacesKeepTheRowsTheClusterDidNotGive(t *testing.T) {
	api := &namespaceAPI{refused: map[string]int{"ns-01": http.StatusForbidden, "ns-02": http.StatusNotFound}}
	s := api.service(t)
	got, err := s.GetNamespaces(scopedCaller(scopeOf(3)))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0]["status"] != "Terminating" {
		t.Fatalf("rows = %v", got)
	}
	for _, row := range got[1:] {
		labels, _ := row["labels"].(map[string]string)
		if row["status"] != "Active" || row["created_at"] != "" || labels == nil || len(labels) != 0 {
			t.Errorf("row %v, want the grant's own row", row)
		}
	}
}

// A request that left before the namespaces were read gets an error, not rows the cluster never gave.
func TestScopedNamespacesOfALeftRequestAreAnError(t *testing.T) {
	api := &namespaceAPI{release: make(chan struct{})}
	s := api.service(t)
	t.Cleanup(func() { close(api.release) })
	ctx, cancel := context.WithCancel(scopedCaller(scopeOf(20)))
	time.AfterFunc(50*time.Millisecond, cancel)
	got, err := s.GetNamespaces(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v with %d rows, want context.Canceled", err, len(got))
	}
}
