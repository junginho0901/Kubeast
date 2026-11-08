package k8s

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// The clients' rate is the one set (100 and 200 if none), the checks' own only when set, and a check goes out as the caller.
func TestClientRatesAreTheOnesSet(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		review := &authorizationv1.SelfSubjectAccessReview{}
		if _, _, err := scheme.Codecs.UniversalDeserializer().Decode(body, nil, review); err != nil {
			http.Error(w, "unreadable review", http.StatusBadRequest)
			return
		}
		mu.Lock()
		asked = append(asked, r.Header.Get(auth.HeaderImpersonateUser))
		mu.Unlock()
		review.APIVersion, review.Kind, review.Status.Allowed = "authorization.k8s.io/v1", "SelfSubjectAccessReview", true
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(review)
	}))
	t.Cleanup(srv.Close)
	impersonationEnabled = true
	t.Cleanup(func() { impersonationEnabled, clientRates = false, rates{} })
	info := cluster.Info{ID: "c", KubeconfigBlob: strings.Replace(testKubeconfig, "https://127.0.0.1:6443", srv.URL, 1)}
	review := &authorizationv1.SelfSubjectAccessReview{Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{Verb: "list", Resource: "pods"}}}

	cases := []struct {
		name                   string
		set                    rates
		qps, reviewQPS         float32
		burst                  int
		reviewsShareTheClients bool
	}{
		{"none set", rates{}, 100, 100, 200, true},
		{"the clients' rate", rates{qps: 300, burst: 600}, 300, 300, 600, true},
		{"the checks' own rate", rates{qps: 100, burst: 200, reviewQPS: 500}, 100, 500, 200, false},
	}
	for _, c := range cases {
		clientRates = c.set
		b, err := buildClientBundle(info)
		if err != nil {
			t.Fatal(err)
		}
		clients, reviews := b.clientset.CoreV1().RESTClient().GetRateLimiter(), b.authz.RESTClient().GetRateLimiter()
		if b.restConfig.QPS != c.qps || b.restConfig.Burst != c.burst || clients.QPS() != c.qps {
			t.Errorf("%s: client rate %v/%d (limiter %v), want %v/%d", c.name, b.restConfig.QPS, b.restConfig.Burst, clients.QPS(), c.qps, c.burst)
		}
		if (clients == reviews) != c.reviewsShareTheClients || reviews.QPS() != c.reviewQPS {
			t.Errorf("%s: the checks share the clients' limiter %v (want %v) at %v (want %v)", c.name, clients == reviews, c.reviewsShareTheClients, reviews.QPS(), c.reviewQPS)
		}
		if _, err := b.authz.SelfSubjectAccessReviews().Create(wideCaller("reader@example.com"), review, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		last := asked[len(asked)-1]
		mu.Unlock()
		if last != "reader@example.com" {
			t.Errorf("%s: a check went out as %q, want the caller", c.name, last)
		}
	}
}
