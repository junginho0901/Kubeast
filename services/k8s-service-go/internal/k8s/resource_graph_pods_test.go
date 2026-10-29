package k8s

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// The graph lists pods podListChunk at a time and keeps only the chosen namespaces' pods: two pages, a pod of a
// namespace not chosen left out.
func TestFetchResourceGraphData_PodsInPagesWithinTheNamespaces(t *testing.T) {
	pod := func(ns, name string) corev1.Pod {
		return corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name}}
	}
	var limits []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasSuffix(r.URL.Path, "/pods") {
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		limits = append(limits, r.URL.Query().Get("limit"))
		list := corev1.PodList{Items: []corev1.Pod{pod("a", "a-1"), pod("c", "c-1")}, ListMeta: metav1.ListMeta{Continue: "next"}}
		if r.URL.Query().Get("continue") == "next" {
			list = corev1.PodList{Items: []corev1.Pod{pod("b", "b-1")}}
		}
		_ = json.NewEncoder(w).Encode(list)
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
	var got []string
	for _, p := range res.pods {
		got = append(got, p.namespace+"/"+p.name)
	}
	if want := []string{"a/a-1", "b/b-1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("pods = %v, want %v", got, want)
	}
	if want := []string{"500", "500"}; !reflect.DeepEqual(limits, want) {
		t.Fatalf("limits = %v, want %v", limits, want)
	}
}

// A pod's edges are the ones the graph drew from the full Pod: owners, then volumes, then env, in that order.
func TestBuildWorkloadGraph_PodEdgesFromTheShortRow(t *testing.T) {
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "ns", Name: "web-1", OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "web-rs"}}},
		Spec: corev1.PodSpec{
			Volumes: []corev1.Volume{
				{Name: "c", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: "cfg"}}}},
				{Name: "d", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "data"}}},
			},
			Containers: []corev1.Container{{
				Name:    "app",
				EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: "creds"}}}},
				Env:     []corev1.EnvVar{{Name: "X", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: "flags"}, Key: "x"}}}},
			}},
		},
	}
	res := &rgResources{pods: []rgPod{toRGPod(&p)}}
	nodes := map[string]rgNode{}
	add := func(n rgNode) {
		if _, ok := nodes[n.ID]; !ok {
			nodes[n.ID] = n
		}
	}
	edges := buildWorkloadGraph(res, nodes, add, nil, func(string) bool { return true })
	var got []string
	for _, e := range edges {
		got = append(got, e.Source+" "+e.Type+" "+e.Target)
	}
	want := []string{
		"ReplicaSet/ns/web-rs owns Pod/ns/web-1",
		"Pod/ns/web-1 mounts ConfigMap/ns/cfg",
		"Pod/ns/web-1 mounts PersistentVolumeClaim/ns/data",
		"Pod/ns/web-1 mounts Secret/ns/creds",
		"Pod/ns/web-1 mounts ConfigMap/ns/flags",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("edges =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if _, ok := nodes["PersistentVolumeClaim/ns/data"]; ok {
		t.Fatal("a mounted PVC became a node without being listed")
	}
	if n := nodes["Pod/ns/web-1"]; n.OwnerKind != "ReplicaSet" || n.Ready != "0/1" {
		t.Fatalf("pod node = %+v", n)
	}
}
