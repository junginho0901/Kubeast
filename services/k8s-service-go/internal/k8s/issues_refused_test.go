package k8s

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// refusingAPI answers every list empty but those it refuses ("<namespace>/<resource>"), as a cluster where a namespace of
// a grant is not bound, and one Deployment of every namespace it answers, short of a replica.
func refusingAPI(t *testing.T, refused ...string) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		resource, namespace := parts[len(parts)-1], ""
		if len(parts) >= 3 && parts[len(parts)-3] == "namespaces" {
			namespace = parts[len(parts)-2]
		}
		for _, ref := range refused {
			if ref == namespace+"/"+resource {
				w.WriteHeader(http.StatusForbidden)
				_, _ = fmt.Fprintf(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"%s is forbidden in the namespace \"%s\""}`, resource, namespace)
				return
			}
		}
		items := ""
		if resource == "deployments" {
			items = fmt.Sprintf(`{"metadata":{"name":"web","namespace":"%s"},"spec":{"replicas":2},"status":{"replicas":2,"readyReplicas":1,"availableReplicas":1}}`, namespace)
		}
		_, _ = fmt.Fprintf(w, `{"metadata":{},"items":[%s]}`, items)
	}))
	t.Cleanup(srv.Close)
	k, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: k})
	return s
}

func checkIssues(t *testing.T, s *Service, ctx context.Context) (rows []string, unread map[string]Issue) {
	t.Helper()
	issues, err := s.CollectIssues(ctx, IssuesOptions{Now: time.Now(), Window: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	unread = map[string]Issue{}
	for _, is := range issues {
		if is.Kind == "Collector" {
			unread[is.Name] = is
			continue
		}
		rows = append(rows, is.ID)
	}
	return rows, unread
}

// The check of a grant limited to namespaces names the lists a namespace of it refused, beside what the others hold.
func TestIssuesNameTheNamespacesOfAGrantThatWereNotRead(t *testing.T) {
	every := []string{"pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs", "horizontalpodautoscalers", "persistentvolumeclaims", "events"}
	names := map[string]string{"horizontalpodautoscalers": "hpas", "persistentvolumeclaims": "pvcs"}
	refusedIn := func(ns string) []string {
		var out []string
		for _, r := range every {
			out = append(out, ns+"/"+r)
		}
		return out
	}

	// none refused: no such row
	rows, unread := checkIssues(t, refusingAPI(t), scopedCaller([]string{"a", "b"}))
	if len(unread) != 0 || !reflect.DeepEqual(rows, []string{"Deployment/a/web", "Deployment/b/web"}) {
		t.Fatalf("none refused: %v %v", rows, unread)
	}

	// one list of one namespace
	rows, unread = checkIssues(t, refusingAPI(t, "a/deployments"), scopedCaller([]string{"a", "b"}))
	if len(unread) != 1 || !reflect.DeepEqual(rows, []string{"Deployment/b/web"}) {
		t.Fatalf("one list: %v %v", rows, unread)
	}
	got := unread["deployments"]
	if got.ID != "Collector/deployments" || got.Severity != "info" || got.Reason != "ListFailed" || got.Namespace != "" || !reflect.DeepEqual(got.Namespaces, []string{"a"}) ||
		got.Message != `not read in a: list all deployments: deployments is forbidden in the namespace "a"` {
		t.Fatalf("the row: %+v", got)
	}

	// a namespace not bound: every list of it, the pods and the events too, each a row
	_, unread = checkIssues(t, refusingAPI(t, refusedIn("b")...), scopedCaller([]string{"a", "b", "c"}))
	if len(unread) != len(every) {
		t.Fatalf("a namespace not bound: %v", unread)
	}
	for _, r := range every {
		name := r
		if n := names[r]; n != "" {
			name = n
		}
		if is := unread[name]; !reflect.DeepEqual(is.Namespaces, []string{"b"}) || !strings.HasPrefix(is.Message, "not read in b: ") {
			t.Errorf("%s: %+v", name, is)
		}
	}

	// two of them, in the grant's order, and the first one's reason; more than the message lists are counted
	_, unread = checkIssues(t, refusingAPI(t, "c/jobs", "a/jobs"), scopedCaller([]string{"a", "b", "c"}))
	if is := unread["jobs"]; !reflect.DeepEqual(is.Namespaces, []string{"a", "c"}) || !strings.HasPrefix(is.Message, "not read in a, c: ") || !strings.Contains(is.Message, `the namespace "a"`) {
		t.Errorf("two: %+v", is)
	}
	var scope, refused []string
	for i := range 9 {
		ns := fmt.Sprintf("team-%d", i)
		scope = append(scope, ns)
		if i < 8 {
			refused = append(refused, ns+"/jobs")
		}
	}
	_, unread = checkIssues(t, refusingAPI(t, refused...), scopedCaller(scope))
	if is := unread["jobs"]; len(is.Namespaces) != 8 || !strings.HasPrefix(is.Message, "not read in team-0, team-1, team-2, team-3, team-4 and 3 more: ") {
		t.Errorf("eight: %+v", is)
	}

	// refused in all of them: the list's own failure, as it was
	_, unread = checkIssues(t, refusingAPI(t, "a/jobs", "b/jobs"), scopedCaller([]string{"a", "b"}))
	if is := unread["jobs"]; is.Namespaces != nil || is.Message != `list all jobs: jobs is forbidden in the namespace "a"` {
		t.Errorf("all: %+v", is)
	}
	// a caller not limited to namespaces: as it was
	_, unread = checkIssues(t, refusingAPI(t, "/jobs"), context.Background())
	if is := unread["jobs"]; is.Namespaces != nil || is.Message != `list all jobs: jobs is forbidden in the namespace ""` {
		t.Errorf("the cluster: %+v", is)
	}
}

// A read that does not ask which namespaces were refused has the list it had.
func TestRefusedNamespacesAreNotedForTheReadThatAsked(t *testing.T) {
	list := func(ns string) ([]map[string]interface{}, error) {
		if ns == "gone" {
			return nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "", errors.New("no binding"))
		}
		return []map[string]interface{}{{"namespace": ns}}, nil
	}
	s := &Service{}
	outer, outerNotes := noteRefusedNamespaces(scopedCtx("api", "gone", "web"))
	inner, innerNotes := noteRefusedNamespaces(outer)
	if out, err := s.listAcrossNamespaces(inner, list); err != nil || len(out) != 2 {
		t.Fatalf("%v %v", out, err)
	}
	if names, why := innerNotes.refused(); !reflect.DeepEqual(names, []string{"gone"}) || !apierrors.IsForbidden(why) {
		t.Errorf("inner: %v %v", names, why)
	}
	if names, _ := outerNotes.refused(); names != nil {
		t.Errorf("outer: %v", names)
	}
	if out, err := s.listAcrossNamespaces(scopedCtx("api", "gone", "web"), list); err != nil || len(out) != 2 {
		t.Errorf("not asked: %v %v", out, err)
	}
	// refused everywhere is the read's error, not a note beside it
	ctx, notes := noteRefusedNamespaces(scopedCtx("gone"))
	if _, err := s.listAcrossNamespaces(ctx, list); !apierrors.IsForbidden(err) {
		t.Errorf("everywhere: %v", err)
	}
	if names, _ := notes.refused(); names != nil {
		t.Errorf("everywhere: %v", names)
	}
}
