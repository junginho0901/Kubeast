package k8s

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// pager serves n pods in pages of the asked limit, as the API server does with continue tokens.
func pager(n int, asked *[]metav1.ListOptions) func(metav1.ListOptions) (rawPage, error) {
	return namedPager("p", n, asked)
}

// namedPager serves n pods named <prefix>-<i>, each with the status "S<i>".
func namedPager(prefix string, n int, asked *[]metav1.ListOptions) func(metav1.ListOptions) (rawPage, error) {
	return func(opts metav1.ListOptions) (rawPage, error) {
		*asked = append(*asked, opts)
		from := 0
		if opts.Continue != "" {
			fmt.Sscanf(opts.Continue, "%d", &from)
		}
		to := from + int(opts.Limit)
		if to > n {
			to = n
		}
		l := &unstructured.UnstructuredList{}
		l.SetKind("PodList")
		l.SetAPIVersion("v1")
		var status []string
		for i := from; i < to; i++ {
			p := unstructured.Unstructured{Object: map[string]interface{}{"kind": "Pod", "metadata": map[string]interface{}{"name": fmt.Sprintf("%s-%d", prefix, i)}}}
			p.SetManagedFields([]metav1.ManagedFieldsEntry{{Manager: "kubectl"}})
			l.Items = append(l.Items, p)
			status = append(status, fmt.Sprintf("S%d", i))
		}
		if to < n {
			l.SetContinue(fmt.Sprint(to))
			rest := int64(n - to)
			l.SetRemainingItemCount(&rest)
		}
		return rawPage{list: l, status: status}, nil
	}
}

func TestStreamPagesAllWithinMax(t *testing.T) {
	var asked []metav1.ListOptions
	heads, names := 0, []string{}
	truncated, remaining, err := streamPages(pager(1200, &asked), metav1.ListOptions{LabelSelector: "app=x"}, 500, 5000,
		func(kind, apiVersion string) error {
			heads++
			if kind != "PodList" || apiVersion != "v1" {
				t.Fatalf("head %s %s", kind, apiVersion)
			}
			return nil
		},
		func(o map[string]interface{}, st *string) error {
			if _, ok := o["metadata"].(map[string]interface{})["managedFields"]; ok {
				t.Fatal("managedFields kept")
			}
			names = append(names, o["metadata"].(map[string]interface{})["name"].(string))
			if st == nil || *st != fmt.Sprintf("S%d", len(names)-1) {
				t.Fatalf("item %d status %v", len(names)-1, st)
			}
			return nil
		})
	if err != nil || truncated || remaining != 0 || heads != 1 || len(names) != 1200 || names[1199] != "p-1199" {
		t.Fatalf("truncated %v remaining %d err %v heads %d items %d", truncated, remaining, err, heads, len(names))
	}
	if len(asked) != 3 || asked[0].Limit != 500 || asked[1].Continue != "500" || asked[2].Continue != "1000" || asked[2].LabelSelector != "app=x" {
		t.Fatalf("asked %+v", asked)
	}
}

func TestStreamPagesStopsAtMax(t *testing.T) {
	var asked []metav1.ListOptions
	n := 0
	truncated, remaining, err := streamPages(pager(10000, &asked), metav1.ListOptions{}, 500, 5000,
		func(string, string) error { return nil }, func(map[string]interface{}, *string) error { n++; return nil })
	if err != nil || !truncated || n != 5000 || remaining != 5000 || len(asked) != 10 {
		t.Fatalf("truncated %v remaining %d err %v items %d pages %d", truncated, remaining, err, n, len(asked))
	}
}

// The search reads the list as kubectl get's table: the Status column's cell is the status (a pod's
// CrashLoopBackOff while its phase is Running), and a kind without that column has none.
func TestTableToPage(t *testing.T) {
	obj := func(kind, name, phase string) runtime.RawExtension {
		b, _ := json.Marshal(map[string]interface{}{"kind": kind, "apiVersion": "v1", "metadata": map[string]interface{}{"name": name}, "status": map[string]interface{}{"phase": phase}})
		return runtime.RawExtension{Raw: b}
	}
	rest := int64(3)
	pods := &metav1.Table{
		TypeMeta: metav1.TypeMeta{Kind: "Table"},
		ListMeta: metav1.ListMeta{Continue: "next", RemainingItemCount: &rest},
		ColumnDefinitions: []metav1.TableColumnDefinition{
			{Name: "Name", Type: "string", Format: "name"}, {Name: "Ready", Type: "string"}, {Name: "Status", Type: "string"},
			{Name: "Restarts", Type: "string"}, {Name: "Age", Type: "string"},
		},
		Rows: []metav1.TableRow{
			{Cells: []interface{}{"crash", "0/1", "CrashLoopBackOff", "5 (10s ago)", "2m"}, Object: obj("Pod", "crash", "Running")},
			{Cells: []interface{}{"done", "0/1", "Completed", "0", "1h"}, Object: obj("Pod", "done", "Succeeded")},
			{Cells: []interface{}{"short", "0/1"}, Object: obj("Pod", "short", "Pending")},
		},
	}
	p := tableToPage(pods, schema.GroupVersionResource{Version: "v1", Resource: "pods"}, "Pod")
	if p.list.GetKind() != "PodList" || p.list.GetAPIVersion() != "v1" || p.list.GetContinue() != "next" || *p.list.GetRemainingItemCount() != 3 {
		t.Fatalf("list %s %s continue %q", p.list.GetKind(), p.list.GetAPIVersion(), p.list.GetContinue())
	}
	if len(p.list.Items) != 3 || p.list.Items[0].GetName() != "crash" || !slices.Equal(p.status, []string{"CrashLoopBackOff", "Completed", ""}) {
		t.Fatalf("items %d status %q", len(p.list.Items), p.status)
	}
	deploys := &metav1.Table{
		TypeMeta:          metav1.TypeMeta{Kind: "Table"},
		ColumnDefinitions: []metav1.TableColumnDefinition{{Name: "Name", Format: "name"}, {Name: "Ready"}, {Name: "Up-to-date"}},
		Rows:              []metav1.TableRow{{Cells: []interface{}{"web", "1/1", 1}, Object: obj("Deployment", "web", "")}},
	}
	p = tableToPage(deploys, schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}, "Deployment")
	if p.list.GetKind() != "DeploymentList" || p.list.GetAPIVersion() != "apps/v1" || len(p.list.Items) != 1 || p.status != nil {
		t.Fatalf("list %s %s items %d status %q", p.list.GetKind(), p.list.GetAPIVersion(), len(p.list.Items), p.status)
	}
	// an empty page is still a list of the kind, as the plain list says
	p = tableToPage(&metav1.Table{TypeMeta: metav1.TypeMeta{Kind: "Table"}, ColumnDefinitions: pods.ColumnDefinitions}, schema.GroupVersionResource{Version: "v1", Resource: "pods"}, "Pod")
	if p.list.GetKind() != "PodList" || len(p.list.Items) != 0 {
		t.Fatalf("empty list %s items %d", p.list.GetKind(), len(p.list.Items))
	}
}

// A grant limited to namespaces is listed namespace by namespace with one head and one max; a namespace the cluster
// refuses or does not have is skipped unless none could be read.
func TestStreamNamespaces(t *testing.T) {
	gr := schema.GroupResource{Resource: "pods"}
	listIn := func(sizes map[string]int) func(ns string) func(metav1.ListOptions) (rawPage, error) {
		return func(ns string) func(metav1.ListOptions) (rawPage, error) {
			switch ns {
			case "refused":
				return func(metav1.ListOptions) (rawPage, error) {
					return rawPage{}, fmt.Errorf("list pods: %w", apierrors.NewForbidden(gr, "", fmt.Errorf("no")))
				}
			case "gone":
				return func(metav1.ListOptions) (rawPage, error) { return rawPage{}, apierrors.NewNotFound(gr, ns) }
			}
			var asked []metav1.ListOptions
			return namedPager(ns, sizes[ns], &asked)
		}
	}
	run := func(scope []string, sizes map[string]int, max int) (names []string, heads int, truncated bool, remaining int64, err error) {
		truncated, remaining, err = streamNamespaces(scope, listIn(sizes), metav1.ListOptions{}, 2, max,
			func(string, string) error { heads++; return nil },
			func(o map[string]interface{}, st *string) error {
				names = append(names, o["metadata"].(map[string]interface{})["name"].(string)+"="+*st)
				return nil
			})
		return
	}
	names, heads, truncated, remaining, err := run([]string{"a", "refused", "b", "gone"}, map[string]int{"a": 3, "b": 4}, 100)
	if err != nil || truncated || heads != 1 || !slices.Equal(names, []string{"a-0=S0", "a-1=S1", "a-2=S2", "b-0=S0", "b-1=S1", "b-2=S2", "b-3=S3"}) {
		t.Fatalf("all: names %v heads %d truncated %v err %v", names, heads, truncated, err)
	}
	// the max is shared: cut in b, more namespaces after it, so the rest is not counted
	names, _, truncated, remaining, err = run([]string{"a", "b", "c"}, map[string]int{"a": 3, "b": 4, "c": 1}, 5)
	if err != nil || !truncated || remaining != 0 || len(names) != 5 || names[4] != "b-1=S1" {
		t.Fatalf("cut: names %v truncated %v remaining %d err %v", names, truncated, remaining, err)
	}
	// cut in the last namespace: the API server's count of the rest
	names, _, truncated, remaining, err = run([]string{"a", "b"}, map[string]int{"a": 3, "b": 4}, 4)
	if err != nil || !truncated || remaining != 3 || len(names) != 4 {
		t.Fatalf("cut last: names %v truncated %v remaining %d err %v", names, truncated, remaining, err)
	}
	// none could be read: the refusal, not an empty list
	if _, heads, _, _, err = run([]string{"refused", "gone"}, nil, 100); !apierrors.IsForbidden(err) || heads != 0 {
		t.Fatalf("refused: heads %d err %v", heads, err)
	}
	// only namespaces the cluster does not have: nothing, no error
	if names, heads, _, _, err = run([]string{"gone"}, nil, 100); err != nil || heads != 0 || len(names) != 0 {
		t.Fatalf("gone: names %v heads %d err %v", names, heads, err)
	}
}
