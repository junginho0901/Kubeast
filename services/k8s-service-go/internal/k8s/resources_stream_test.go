package k8s

import (
	"fmt"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// pager serves n pods in pages of the asked limit, as the API server does with continue tokens.
func pager(n int, asked *[]metav1.ListOptions) func(metav1.ListOptions) (*unstructured.UnstructuredList, error) {
	return func(opts metav1.ListOptions) (*unstructured.UnstructuredList, error) {
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
		for i := from; i < to; i++ {
			p := unstructured.Unstructured{Object: map[string]interface{}{"kind": "Pod", "metadata": map[string]interface{}{"name": fmt.Sprintf("p-%d", i)}}}
			p.SetManagedFields([]metav1.ManagedFieldsEntry{{Manager: "kubectl"}})
			l.Items = append(l.Items, p)
		}
		if to < n {
			l.SetContinue(fmt.Sprint(to))
			rest := int64(n - to)
			l.SetRemainingItemCount(&rest)
		}
		return l, nil
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
		func(o map[string]interface{}) error {
			if _, ok := o["metadata"].(map[string]interface{})["managedFields"]; ok {
				t.Fatal("managedFields kept")
			}
			names = append(names, o["metadata"].(map[string]interface{})["name"].(string))
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
		func(string, string) error { return nil }, func(map[string]interface{}) error { n++; return nil })
	if err != nil || !truncated || n != 5000 || remaining != 5000 || len(asked) != 10 {
		t.Fatalf("truncated %v remaining %d err %v items %d pages %d", truncated, remaining, err, n, len(asked))
	}
}
