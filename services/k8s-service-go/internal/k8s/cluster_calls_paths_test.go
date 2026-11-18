package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// callsService is a Service whose cluster c1 is at url, with no overview informers.
func callsService(t *testing.T, url string) *Service {
	t.Helper()
	kc := strings.Replace(testKubeconfig, "https://127.0.0.1:6443", url, 1)
	reg := &identityRegistry{info: cluster.Info{ID: "c1", Mode: cluster.ModeExternal, KubeconfigBlob: kc}}
	wasImpersonation, wasOff, wasRates := impersonationEnabled, informersOff, clientRates
	t.Cleanup(func() { impersonationEnabled, informersOff, clientRates = wasImpersonation, wasOff, wasRates })
	s, err := NewService(context.Background(), reg, false, cache.New("", 0, 0, ""), ServiceOptions{MaxClusters: 20, NoInformers: true})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// The reads Kubeast makes apart from the request's values count for the request they were made for: the reads kept
// once for everyone, which go out as Kubeast with none of the caller's values, and a config whose callers send their
// own contexts (the Helm SDK). A cluster that refuses them is unreached, and their answer is the API server's answer.
func TestReadsMadeApartFromTheRequestCountForIt(t *testing.T) {
	paths := map[string]func(ctx context.Context, s *Service){
		"a node's pods read once for everyone": func(ctx context.Context, s *Service) {
			if b, err := s.For(ctx, "c1"); err == nil {
				_, _ = readNodePods(ctx, b.cacheClient, "n1")
			}
		},
		"an object's events read once for everyone": func(ctx context.Context, s *Service) {
			if b, err := s.For(ctx, "c1"); err == nil {
				_, _ = readEvents(ctx, b.cacheClient, "a", "involvedObject.uid=u1")
			}
		},
		"the server version": func(ctx context.Context, s *Service) {
			if b, err := s.For(ctx, "c1"); err == nil {
				_, _ = b.serverVersionInfo(ctx, 0)
			}
		},
		"the discovery lists": func(ctx context.Context, s *Service) { _, _, _ = s.apiResources(ctx) },
		"a kind's served versions": func(ctx context.Context, s *Service) {
			_, _ = s.discoverResource(ctx, "apps", "deployments")
		},
		"a config whose callers send their own contexts": func(ctx context.Context, s *Service) {
			cfg, err := s.UserRESTConfigFor(ctx)
			if err != nil {
				t.Errorf("UserRESTConfigFor: %v", err)
				return
			}
			cs, err := kubernetes.NewForConfig(cfg)
			if err != nil {
				t.Errorf("clientset: %v", err)
				return
			}
			_, _ = cs.CoreV1().Namespaces().List(context.Background(), metav1.ListOptions{})
		},
	}
	answering := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer answering.Close()
	for name, read := range paths {
		for where, c := range map[string]struct {
			url       string
			unreached bool
			answered  bool
		}{
			"refused":   {closedAddress(t), true, false},
			"answering": {answering.URL, false, true},
		} {
			t.Run(name+"/"+where, func(t *testing.T) {
				s := callsService(t, c.url)
				answered := false
				person := auth.WithPayload(context.Background(), auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}})
				ctx, calls := WithClusterCalls(cluster.WithID(person, "c1"), "c1", func() { answered = true })
				read(ctx, s)
				if calls.Unreached() != c.unreached || answered != c.answered {
					t.Errorf("unreached %v, answered %v; want %v, %v", calls.Unreached(), answered, c.unreached, c.answered)
				}
			})
		}
	}
}

// A trial the cluster took and did not answer holds the breaker another whole period from when it ended, as a failed
// trial does; it changes nothing for another booking or a breaker closed meanwhile.
func TestATrialTheClusterDidNotAnswerHoldsAnotherPeriod(t *testing.T) {
	const id cluster.ID = "c1"
	const period = 30 * time.Second
	h := newClusterHealth(5, period)
	at := time.Unix(1_000_000, 0)
	h.now = func() time.Time { return at }
	h.setOpen(id, true)
	at = at.Add(period)
	ok, booked := h.admit(id)
	if !ok || booked.IsZero() {
		t.Fatalf("the trial: let through %v, booked %v", ok, booked)
	}
	at = at.Add(period + 10*time.Second) // the trial ends after its booking ran out
	h.rebook(id, booked.Add(-time.Second))
	if ok, _ := h.admit(id); !ok {
		t.Fatal("holding another booking held this one")
	}
	h.setOpen(id, true)
	at = at.Add(period)
	_, booked = h.admit(id)
	at = at.Add(period + 10*time.Second)
	h.rebook(id, booked)
	if ok, _ := h.admit(id); ok {
		t.Fatal("a request let through right after the trial the cluster did not answer")
	}
	at = at.Add(period - time.Second)
	if ok, _ := h.admit(id); ok {
		t.Fatal("a request let through within a period of that trial's end")
	}
	at = at.Add(time.Second)
	ok, booked = h.admit(id)
	if !ok {
		t.Fatal("no request let through a period after that trial")
	}
	h.setOpen(id, false)
	h.rebook(id, booked)
	if h.isOpen(id) {
		t.Error("holding the period of a breaker closed meanwhile opened it")
	}
}
