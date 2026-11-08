package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// rolloutAPI answers the Timeline's lists as the API server does, a page at a time when asked to, and records how each
// list was asked for.
type rolloutAPI struct {
	deploys []appsv1.Deployment
	rs      []appsv1.ReplicaSet
	crs     []appsv1.ControllerRevision
	refuse  string // a kind the cluster refuses

	mu     sync.Mutex
	asks   map[string][]string // kind → limit of each request
	maxLen map[string]int      // kind → the most items of one answer
}

func (a *rolloutAPI) service(t testing.TB) *Service {
	t.Helper()
	a.asks, a.maxLen = map[string][]string{}, map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		kind := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		q := r.URL.Query()
		a.mu.Lock()
		a.asks[kind] = append(a.asks[kind], q.Get("limit"))
		a.mu.Unlock()
		if a.refuse == kind {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"` + kind + ` is forbidden"}`))
			return
		}
		ns := ""
		if parts := strings.Split(r.URL.Path, "/"); len(parts) > 5 && parts[4] == "namespaces" {
			ns = parts[5]
		}
		switch kind {
		case "deployments":
			items, meta := pageOf(a, kind, filterNamespace(a.deploys, ns, func(d appsv1.Deployment) string { return d.Namespace }), q)
			_ = json.NewEncoder(w).Encode(appsv1.DeploymentList{TypeMeta: metav1.TypeMeta{Kind: "DeploymentList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items})
		case "replicasets":
			items, meta := pageOf(a, kind, filterNamespace(a.rs, ns, func(d appsv1.ReplicaSet) string { return d.Namespace }), q)
			_ = json.NewEncoder(w).Encode(appsv1.ReplicaSetList{TypeMeta: metav1.TypeMeta{Kind: "ReplicaSetList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items})
		case "controllerrevisions":
			items, meta := pageOf(a, kind, filterNamespace(a.crs, ns, func(d appsv1.ControllerRevision) string { return d.Namespace }), q)
			_ = json.NewEncoder(w).Encode(appsv1.ControllerRevisionList{TypeMeta: metav1.TypeMeta{Kind: "ControllerRevisionList", APIVersion: "apps/v1"}, ListMeta: meta, Items: items})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: k})
	return s
}

func filterNamespace[T any](items []T, ns string, of func(T) string) []T {
	if ns == "" {
		return items
	}
	var out []T
	for _, it := range items {
		if of(it) == ns {
			out = append(out, it)
		}
	}
	return out
}

func pageOf[T any](a *rolloutAPI, kind string, items []T, q map[string][]string) ([]T, metav1.ListMeta) {
	limit, from := 0, 0
	if v := q["limit"]; len(v) > 0 {
		limit, _ = strconv.Atoi(v[0])
	}
	if v := q["continue"]; len(v) > 0 {
		from, _ = strconv.Atoi(v[0])
	}
	to := len(items)
	if limit > 0 && from+limit < to {
		to = from + limit
	}
	meta := metav1.ListMeta{}
	if to < len(items) {
		meta.Continue = strconv.Itoa(to)
	}
	a.mu.Lock()
	if to-from > a.maxLen[kind] {
		a.maxLen[kind] = to - from
	}
	a.mu.Unlock()
	return items[from:to], meta
}

// rolloutFixture holds more of each kind than one page: rollouts old and new, in two namespaces, owned and not, many in
// the same second so the order of equal times shows.
func rolloutFixture(now time.Time) *rolloutAPI {
	a := &rolloutAPI{}
	for _, ns := range []string{"alpha", "beta"} {
		for d := 0; d < 40; d++ {
			a.deploys = append(a.deploys, appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("d-%d", d), Namespace: ns}})
		}
		for i := 0; i < 700; i++ {
			created := now.Add(-time.Duration(i%30) * time.Minute)
			if i%3 == 0 {
				created = now.Add(-5 * time.Hour)
			}
			rs := rsOwnedBy(ns, fmt.Sprintf("rs-%d", i), fmt.Sprintf("d-%d", i%50), strconv.Itoa(i%9+1), created)
			rs.Annotations["kubernetes.io/change-cause"] = fmt.Sprintf("cause %d", i)
			rs.Annotations["other"] = strings.Repeat("x", 100)
			replicas := int32(i % 4)
			rs.Spec.Replicas = &replicas
			rs.Spec.Template.Spec.Containers[0].Image = fmt.Sprintf("img:%d", i)
			a.rs = append(a.rs, rs)
			if i < 620 {
				cr := appsv1.ControllerRevision{
					ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("cr-%d", i), Namespace: ns, CreationTimestamp: metav1.NewTime(created)},
					Revision:   int64(i),
					Data:       runtime.RawExtension{Raw: []byte(fmt.Sprintf(`{"spec":{"template":{"spec":{"containers":[{"name":"c","image":"cr:%d"}]}}}}`, i))},
				}
				if i%5 != 0 {
					kind := "StatefulSet"
					if i%2 == 0 {
						kind = "DaemonSet"
					}
					yes := true
					cr.OwnerReferences = []metav1.OwnerReference{{Kind: kind, Name: fmt.Sprintf("o-%d", i%7), Controller: &yes}}
				}
				a.crs = append(a.crs, cr)
			}
		}
	}
	return a
}

// A namespace's rollouts are read a page at a time, in the same words and the same order as from whole lists.
func TestNamespaceRolloutsAreReadInPagesAndAnswerTheSame(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	cutoff := now.Add(-time.Hour)
	a := rolloutFixture(now)
	s := a.service(t)
	for _, ns := range []string{"alpha", ""} {
		got, err := s.rolloutHistoryIn(context.Background(), ns, cutoff)
		if err != nil {
			t.Fatal(err)
		}
		want := append(rolloutHistoryFromLists(
			&appsv1.DeploymentList{Items: filterNamespace(a.deploys, ns, func(d appsv1.Deployment) string { return d.Namespace })},
			&appsv1.ReplicaSetList{Items: filterNamespace(a.rs, ns, func(d appsv1.ReplicaSet) string { return d.Namespace })}, cutoff),
			controllerRevisionRollouts(&appsv1.ControllerRevisionList{Items: filterNamespace(a.crs, ns, func(d appsv1.ControllerRevision) string { return d.Namespace })}, cutoff)...)
		sortRolloutsNewestFirst(want)
		if len(want) == 0 {
			t.Fatal("the fixture has no rollouts")
		}
		if !reflect.DeepEqual(rolloutRowsJSON(t, got), rolloutRowsJSON(t, want)) {
			t.Errorf("namespace %q: %d rows differ from the %d whole lists give", ns, len(got), len(want))
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	t.Logf("most items in one answer: %v, requests: rs %d, cr %d, deployments %d", a.maxLen, len(a.asks["replicasets"]), len(a.asks["controllerrevisions"]), len(a.asks["deployments"]))
	for kind, most := range a.maxLen {
		if most > timelinePageSize {
			t.Errorf("%s: one answer of %d items, want at most a page of %d", kind, most, timelinePageSize)
		}
	}
}

// One workload's rollouts too.
func TestOneWorkloadsRolloutsAreReadInPagesAndAnswerTheSame(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	cutoff := now.Add(-time.Hour)
	a := rolloutFixture(now)
	s := a.service(t)
	got, err := s.getDeploymentRolloutTimeline(context.Background(), "alpha", "d-3", cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatal("no rollouts of the Deployment")
	}
	for _, row := range got {
		if row["kind"] != "Deployment" || row["name"] != "d-3" || row["namespace"] != "alpha" {
			t.Errorf("row %v", row)
		}
	}
	crs, err := s.getControllerRevisionTimeline(context.Background(), "alpha", "StatefulSet", "o-1", cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if len(crs) == 0 {
		t.Fatal("no revisions of the StatefulSet")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	t.Logf("most items in one answer: %v", a.maxLen)
	for kind, most := range a.maxLen {
		if most > timelinePageSize {
			t.Errorf("%s: one answer of %d items, want at most a page of %d", kind, most, timelinePageSize)
		}
	}
}

// A kind the cluster refuses is said as before.
func TestARefusedRolloutListIsSaidAsBefore(t *testing.T) {
	now := time.Now()
	for kind, want := range map[string]string{
		"replicasets":         "list replicasets for timeline: ",
		"deployments":         "list deployments for timeline: ",
		"controllerrevisions": "list controller revisions for timeline: ",
	} {
		a := rolloutFixture(now)
		a.refuse = kind
		s := a.service(t)
		_, err := s.rolloutHistoryIn(context.Background(), "alpha", now.Add(-time.Hour))
		if err == nil || !strings.HasPrefix(err.Error(), want) || !strings.Contains(err.Error(), "is forbidden") {
			t.Errorf("%s refused: %v", kind, err)
		}
	}
}

func rolloutRowsJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
