package handler

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

func TestNamespaceScopeMiddleware(t *testing.T) {
	h := &Handler{}
	scoped := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c": {"resource.*.read"}}, Namespaces: map[string][]string{"c": {"api", "web"}}}
	whole := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"c": {"resource.*.read"}}}
	cases := []struct {
		name    string
		payload auth.TokenPayload
		cluster string
		route   string
		path    string
		status  int
	}{
		{"own namespace", scoped, "c", "/api/v1/namespaces/{namespace}/pods", "/api/v1/namespaces/web/pods", http.StatusOK},
		{"own namespace, deep path", scoped, "c", "/api/v1/namespaces/{namespace}/pods/{name}/logs", "/api/v1/namespaces/api/pods/p1/logs", http.StatusOK},
		{"other namespace", scoped, "c", "/api/v1/namespaces/{namespace}/pods", "/api/v1/namespaces/db/pods", http.StatusForbidden},
		{"namespace object itself", scoped, "c", "/api/v1/namespaces/{namespace}", "/api/v1/namespaces/db", http.StatusForbidden},
		{"cluster-scoped kind", scoped, "c", "/api/v1/nodes", "/api/v1/nodes", http.StatusOK},
		{"namespace list", scoped, "c", "/api/v1/namespaces", "/api/v1/namespaces", http.StatusOK},
		{"a route with no rule", scoped, "c", "/api/v1/brand-new", "/api/v1/brand-new", http.StatusForbidden},
		{"another cluster unscoped", scoped, "d", "/api/v1/namespaces/{namespace}/pods", "/api/v1/namespaces/db/pods", http.StatusOK},
		{"unscoped grant", whole, "c", "/api/v1/namespaces/{namespace}/pods", "/api/v1/namespaces/db/pods", http.StatusOK},
	}
	for _, tc := range cases {
		r := chi.NewRouter()
		r.Group(func(g chi.Router) {
			g.Use(h.NamespaceScopeMiddleware)
			g.Get(tc.route, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
		})
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		ctx := auth.WithPayload(cluster.WithID(req.Context(), cluster.ID(tc.cluster)), tc.payload)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req.WithContext(ctx))
		if rec.Code != tc.status {
			t.Errorf("%s: status %d, want %d (%s)", tc.name, rec.Code, tc.status, rec.Body.String())
		}
	}
}

// The namespaces' watches read as one: every namespace's events come through, the first watch to end closes it so all
// are opened again, a refused namespace is left out, and with all refused the answer is the cluster's refusal.
func TestWatchNamespaces(t *testing.T) {
	refused := apierrors.NewForbidden(schema.GroupResource{Resource: "secrets"}, "", errors.New("no binding"))
	shop, cart := watch.NewFake(), watch.NewFake()
	opened := map[string]*watch.FakeWatcher{"shop": shop, "cart": cart}
	m, err := watchNamespaces([]string{"shop", "gone", "cart"}, func(ns string) (watch.Interface, error) {
		if w, ok := opened[ns]; ok {
			return w, nil
		}
		return nil, refused
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		from *watch.FakeWatcher
		name string
	}{{shop, "in-shop"}, {cart, "in-cart"}} {
		go c.from.Add(&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: c.name}})
		select {
		case event := <-m.ResultChan():
			if got := event.Object.(*corev1.Secret).Name; got != c.name {
				t.Fatalf("event of %s, want %s", got, c.name)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no event for %s", c.name)
		}
	}
	shop.Stop()
	select {
	case _, open := <-m.ResultChan():
		if open {
			t.Fatal("an event after the first watch ended")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("still open after the first watch ended")
	}
	if !cart.IsStopped() {
		t.Fatal("the other watch left running")
	}

	if _, err := watchNamespaces([]string{"a", "b"}, func(string) (watch.Interface, error) { return nil, refused }); !apierrors.IsForbidden(err) {
		t.Fatalf("all refused: %v", err)
	}
	down := errors.New("apiserver down")
	left := watch.NewFake()
	calls := 0
	if _, err := watchNamespaces([]string{"a", "b"}, func(string) (watch.Interface, error) {
		if calls++; calls == 1 {
			return left, nil
		}
		return nil, down
	}); !errors.Is(err, down) {
		t.Fatalf("an error that is no refusal: %v", err)
	}
	if !left.IsStopped() {
		t.Fatal("the watch opened before the error left running")
	}
}
