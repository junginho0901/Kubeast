package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// graphAPIServer answers every list with no items, or 403 when the path holds
// one of the forbidden resources, or 500 for broken.
func graphAPIServer(t *testing.T, forbidden []string, broken string) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		resource := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		for _, f := range forbidden {
			if resource == f {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
				return
			}
		}
		if resource == broken {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"InternalError","code":500}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatalf("clientset: %v", err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

func TestFetchResourceGraphData_LeavesOutForbiddenKinds(t *testing.T) {
	s := graphAPIServer(t, []string{"secrets", "storageclasses"}, "")
	res, err := s.fetchResourceGraphData(context.Background(), []string{"default"})
	if err != nil {
		t.Fatalf("a forbidden kind failed the graph: %v", err)
	}
	if want := []string{"Secret", "StorageClass"}; !reflect.DeepEqual(res.forbidden, want) {
		t.Fatalf("forbidden = %v, want %v", res.forbidden, want)
	}
}

func TestFetchResourceGraphData_OtherErrorsFail(t *testing.T) {
	s := graphAPIServer(t, []string{"secrets"}, "pods")
	if _, err := s.fetchResourceGraphData(context.Background(), []string{"default"}); err == nil || !strings.HasPrefix(err.Error(), "Pod: ") {
		t.Fatalf("err = %v, want the Pod list error", err)
	}
}

// With two namespaces chosen each is listed on its own: a kind one of them refuses is named with that namespace,
// a kind both refuse is named alone, and nothing is listed across the cluster.
func TestFetchResourceGraphData_NamespacesRefusedOneByOne(t *testing.T) {
	var cluster []string
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.Contains(r.URL.Path, "/namespaces/") && !strings.HasSuffix(r.URL.Path, "/persistentvolumes") && !strings.HasSuffix(r.URL.Path, "/storageclasses") {
			mu.Lock()
			cluster = append(cluster, r.URL.Path)
			mu.Unlock()
		}
		refuse := strings.HasSuffix(r.URL.Path, "/namespaces/b/secrets") || strings.HasSuffix(r.URL.Path, "/configmaps")
		if refuse {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	res, err := s.fetchResourceGraphData(context.Background(), []string{"a", "b"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"ConfigMap", "Secret (b)"}; !reflect.DeepEqual(res.forbidden, want) {
		t.Fatalf("forbidden = %v, want %v", res.forbidden, want)
	}
	if len(cluster) != 0 {
		t.Fatalf("listed across the cluster: %v", cluster)
	}
}
