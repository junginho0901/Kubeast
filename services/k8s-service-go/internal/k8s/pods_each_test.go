package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// listAPI answers the lists the pod-reading handlers make as the API server does — pages of the asked limit with
// continue tokens and remainingItemCount, label selectors on pods — and the single objects they read. Every pod list
// request is recorded.
type listAPI struct {
	mu      sync.Mutex
	pods    []corev1.Pod
	counts  map[string]int // how many objects each other listed kind has ("services", "configmaps" …)
	objects map[string]any // a GET path → the object answered
	podAsks []map[string]string
}

func (a *listAPI) serve(t *testing.T) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query()
		if o, ok := a.objects[r.URL.Path]; ok {
			_ = json.NewEncoder(w).Encode(o)
			return
		}
		limit, _ := strconv.Atoi(q.Get("limit"))
		from, _ := strconv.Atoi(q.Get("continue"))
		page := func(n int) (int, int, metav1.ListMeta) {
			to := n
			if limit > 0 && from+limit < n {
				to = from + limit
			}
			meta := metav1.ListMeta{}
			if to < n {
				meta.Continue = strconv.Itoa(to)
				rest := int64(n - to)
				meta.RemainingItemCount = &rest
			}
			return from, to, meta
		}
		kind := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		if kind == "pods" {
			a.mu.Lock()
			a.podAsks = append(a.podAsks, map[string]string{"path": r.URL.Path, "limit": q.Get("limit"), "labelSelector": q.Get("labelSelector")})
			a.mu.Unlock()
			sel, _ := labels.Parse(q.Get("labelSelector"))
			ns := ""
			if parts := strings.Split(r.URL.Path, "/"); len(parts) > 4 && parts[3] == "namespaces" {
				ns = parts[4]
			}
			var items []corev1.Pod
			for _, p := range a.pods {
				if (ns == "" || p.Namespace == ns) && (sel == nil || sel.Matches(labels.Set(p.Labels))) {
					items = append(items, p)
				}
			}
			f, to, meta := page(len(items))
			_ = json.NewEncoder(w).Encode(corev1.PodList{TypeMeta: metav1.TypeMeta{Kind: "PodList", APIVersion: "v1"}, ListMeta: meta, Items: items[f:to]})
			return
		}
		if n, ok := a.counts[kind]; ok || r.Method == http.MethodGet {
			f, to, meta := page(n)
			items := make([]map[string]any, 0, to-f)
			for i := f; i < to; i++ {
				items = append(items, map[string]any{"metadata": map[string]any{"name": fmt.Sprintf("%s-%d", kind, i), "namespace": "bulk"}})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"metadata": meta, "items": items})
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}`))
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

// everyPodAskPaged fails unless every pod list asked for a page or a selector — none for the whole namespace at once.
func (a *listAPI) everyPodAskPaged(t *testing.T) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.podAsks) == 0 {
		t.Fatal("no pod list was made")
	}
	for _, ask := range a.podAsks {
		if ask["limit"] != strconv.Itoa(podListChunk) {
			t.Fatalf("a pod list without the page size: %v", ask)
		}
	}
}

func bulkPod(i int, app string, phase corev1.PodPhase, cpu, mem string) corev1.Pod {
	res := corev1.ResourceRequirements{}
	if cpu != "" {
		res.Requests = corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(cpu), corev1.ResourceMemory: resource.MustParse(mem)}
		res.Limits = corev1.ResourceList{corev1.ResourceCPU: resource.MustParse(cpu), corev1.ResourceMemory: resource.MustParse(mem)}
	}
	return corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("%s-%04d", app, i), Namespace: "bulk", Labels: map[string]string{"app": app},
			OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "rs-" + app, Controller: ptrBool(true)}}},
		Spec:   corev1.PodSpec{NodeName: "n1", Containers: []corev1.Container{{Name: "c", Resources: res}}},
		Status: corev1.PodStatus{Phase: phase},
	}
}

func ptrBool(b bool) *bool { return &b }

// eachPod reads every pod a page of podListChunk at a time and hands each to the caller once.
func TestEachPod_PagesOfTheChunkSize(t *testing.T) {
	api := &listAPI{}
	for i := 0; i < 1234; i++ {
		api.pods = append(api.pods, bulkPod(i, "a", corev1.PodRunning, "", ""))
	}
	s := api.serve(t)
	seen := map[string]bool{}
	if err := eachPod(context.Background(), s.clientsetCtx(context.Background()).CoreV1(), "bulk", metav1.ListOptions{}, func(p *corev1.Pod) { seen[p.Name] = true }); err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1234 {
		t.Fatalf("saw %d pods", len(seen))
	}
	api.everyPodAskPaged(t)
	if len(api.podAsks) != 3 {
		t.Fatalf("%d requests for 1 234 pods in pages of %d", len(api.podAsks), podListChunk)
	}
}

// countList counts from one item and the remaining count; without it, page by page.
func TestCountList(t *testing.T) {
	rest := int64(41)
	got, err := countList(func(o metav1.ListOptions) (int, metav1.ListMeta, error) {
		if o.Limit != 1 {
			t.Fatalf("the first page asked %d items", o.Limit)
		}
		return 1, metav1.ListMeta{Continue: "1", RemainingItemCount: &rest}, nil
	})
	if err != nil || got != 42 {
		t.Fatalf("with the remaining count: %d %v", got, err)
	}
	asks := 0
	got, err = countList(func(o metav1.ListOptions) (int, metav1.ListMeta, error) {
		asks++
		switch o.Continue {
		case "":
			return 1, metav1.ListMeta{Continue: "a"}, nil
		case "a":
			return podListChunk, metav1.ListMeta{Continue: "b"}, nil
		default:
			return 7, metav1.ListMeta{}, nil
		}
	})
	if err != nil || got != 1+podListChunk+7 || asks != 3 {
		t.Fatalf("without the remaining count: %d after %d asks, %v", got, asks, err)
	}
	got, _ = countList(func(metav1.ListOptions) (int, metav1.ListMeta, error) { return 0, metav1.ListMeta{}, nil })
	if got != 0 {
		t.Fatalf("empty: %d", got)
	}
}

// The Namespace drawer gets its counts without listing the objects, and its pods' count, phases and requests and
// limits summed from pages — the same numbers as the pods listed and summed whole.
func TestDescribeNamespace_CountsAndPodSummaryWithoutAWholeList(t *testing.T) {
	api := &listAPI{
		counts:  map[string]int{"services": 7, "deployments": 3, "configmaps": 1200, "secrets": 0, "resourcequotas": 0, "limitranges": 0, "events": 0},
		objects: map[string]any{"/api/v1/namespaces/bulk": corev1.Namespace{TypeMeta: metav1.TypeMeta{Kind: "Namespace", APIVersion: "v1"}, ObjectMeta: metav1.ObjectMeta{Name: "bulk"}, Status: corev1.NamespaceStatus{Phase: corev1.NamespaceActive}}},
	}
	want := namespacePodSummary{Phases: map[string]int{}}
	for i := 0; i < 1100; i++ {
		phase, cpu, mem := corev1.PodRunning, "100m", "64Mi"
		if i%10 == 0 {
			phase, cpu, mem = corev1.PodPending, "250m", "1Gi"
		}
		p := bulkPod(i, "a", phase, cpu, mem)
		api.pods = append(api.pods, p)
		want.add(&p)
	}
	s := api.serve(t)
	res, err := s.DescribeNamespace(context.Background(), "bulk")
	if err != nil {
		t.Fatal(err)
	}
	counts := res["resource_counts"].(map[string]int)
	if counts["pods"] != 1100 || counts["services"] != 7 || counts["deployments"] != 3 || counts["configmaps"] != 1200 || counts["secrets"] != 0 {
		t.Fatalf("counts %v", counts)
	}
	got := res["pod_summary"].(namespacePodSummary)
	if got.Total != 1100 || got.Phases["Running"] != 990 || got.Phases["Pending"] != 110 ||
		got.CPURequestsM != 990*100+110*250 || got.MemoryLimits != want.MemoryLimits || got.CPULimitsM != want.CPULimitsM || got.MemoryRequests != want.MemoryRequests {
		t.Fatalf("summary %+v, want %+v", got, want)
	}
	api.everyPodAskPaged(t)
}

// A ReplicaSet's pods are listed by its selector a page at a time, as kubectl describe does, and are the pods it owns.
func TestListOwnedPods_BySelectorAPageAtATime(t *testing.T) {
	api := &listAPI{}
	for i := 0; i < 600; i++ {
		api.pods = append(api.pods, bulkPod(i, "a", corev1.PodRunning, "", ""), bulkPod(i, "b", corev1.PodRunning, "", ""))
	}
	s := api.serve(t)
	got, err := s.listOwnedPods(context.Background(), "bulk", "ReplicaSet", "rs-a", &metav1.LabelSelector{MatchLabels: map[string]string{"app": "a"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 600 || !strings.HasPrefix(got[0]["name"].(string), "a-") {
		t.Fatalf("owned %d, first %v", len(got), got[0]["name"])
	}
	api.everyPodAskPaged(t)
	for _, ask := range api.podAsks {
		if ask["labelSelector"] != "app=a" {
			t.Fatalf("listed without the ReplicaSet's selector: %v", ask)
		}
	}
	// a selector-less controller (not valid in the API, but the code must not list the namespace whole either)
	api.podAsks = nil
	if _, err := s.listOwnedPods(context.Background(), "bulk", "ReplicaSet", "rs-a", nil); err != nil {
		t.Fatal(err)
	}
	api.everyPodAskPaged(t)
}

// The GPU dashboard reads the pods a page at a time and keeps the ones asking for a GPU.
func TestGPUDashboard_PodsAPageAtATime(t *testing.T) {
	api := &listAPI{counts: map[string]int{"nodes": 0}}
	for i := 0; i < 1200; i++ {
		p := bulkPod(i, "a", corev1.PodRunning, "", "")
		if i%400 == 0 {
			p.Spec.Containers[0].Resources.Limits = corev1.ResourceList{"nvidia.com/gpu": resource.MustParse("2")}
		}
		api.pods = append(api.pods, p)
	}
	s := api.serve(t)
	res, err := s.GetGPUDashboard(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if pods := res["gpu_pods"].([]map[string]interface{}); len(pods) != 3 || res["total_gpu_used"] != 6 {
		t.Fatalf("gpu pods %d, used %v", len(pods), res["total_gpu_used"])
	}
	api.everyPodAskPaged(t)
}

// The pods of a PVC (and of a PV's claim) are found a page at a time.
func TestDescribePVC_PodsUsingItAPageAtATime(t *testing.T) {
	pvc := corev1.PersistentVolumeClaim{TypeMeta: metav1.TypeMeta{Kind: "PersistentVolumeClaim", APIVersion: "v1"}, ObjectMeta: metav1.ObjectMeta{Name: "data", Namespace: "bulk"}}
	api := &listAPI{counts: map[string]int{"events": 0}, objects: map[string]any{"/api/v1/namespaces/bulk/persistentvolumeclaims/data": pvc}}
	for i := 0; i < 700; i++ {
		p := bulkPod(i, "a", corev1.PodRunning, "", "")
		if i == 650 {
			p.Spec.Volumes = []corev1.Volume{{Name: "v", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data"}}}}
		}
		api.pods = append(api.pods, p)
	}
	s := api.serve(t)
	res, err := s.DescribePVC(context.Background(), "bulk", "data")
	if err != nil {
		t.Fatal(err)
	}
	if used := res["used_by_pods"].([]map[string]interface{}); len(used) != 1 || used[0]["name"] != "a-0650" {
		t.Fatalf("used by %v", used)
	}
	api.everyPodAskPaged(t)
}

// The pod lists of this package page or narrow: none asks for every pod of a namespace or the cluster at once. A
// namespace of 50 000 pods as one list took k8s-service past 512 Mi from one request (the GPU dashboard, the
// Namespace and ReplicaSet drawers, 10-30). A new whole list fails here; page it with eachPod.
func TestNoWholePodList(t *testing.T) {
	whole := regexp.MustCompile(`Pods\([^)]*\)\.List\([^,]+,\s*metav1\.ListOptions\{\}\)`)
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if loc := whole.FindIndex(b); loc != nil {
			line := strings.Count(string(b[:loc[0]]), "\n") + 1
			t.Errorf("%s:%d lists every pod at once: %s", f, line, b[loc[0]:loc[1]])
		}
	}
}
