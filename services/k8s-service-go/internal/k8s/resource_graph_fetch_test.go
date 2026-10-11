package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
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
