package k8s

import (
	"context"
	"reflect"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// withUID is e naming the UID of the object it is about, as an event recorder writes it.
func withUID(uid types.UID, e corev1.Event) corev1.Event {
	e.InvolvedObject.UID = uid
	return e
}

// naming is events that name uid.
func naming(uid types.UID, events ...corev1.Event) []corev1.Event {
	out := make([]corev1.Event, len(events))
	for i, e := range events {
		out[i] = withUID(uid, e)
	}
	return out
}

func TestEventUIDsKeepWhatNamesTheObject(t *testing.T) {
	now := time.Now()
	events := []corev1.Event{
		withUID("now", gatewayEvent("ns", "Deployment", "web", "Scaled", now)),
		withUID("before", gatewayEvent("ns", "Deployment", "web", "OfTheOneBefore", now)),
		gatewayEvent("ns", "Deployment", "web", "NamesNoUID", now),
		withUID("web-node", gatewayEvent("", "Node", "web-node", "ByName", now)),
	}
	reasonsOf := func(items []corev1.Event) []string {
		out := []string{}
		for _, e := range items {
			out = append(out, e.Reason)
		}
		return out
	}
	for _, c := range []struct {
		uids eventUIDs
		want []string
	}{
		{about("now"), []string{"Scaled"}},
		{about("now", "web-node"), []string{"Scaled", "ByName"}},
		// kubectl leaves the selector out when the object has no UID: the list stays as read
		{about(), []string{"Scaled", "OfTheOneBefore", "NamesNoUID", "ByName"}},
		{about(""), []string{"Scaled", "OfTheOneBefore", "NamesNoUID", "ByName"}},
	} {
		if got := reasonsOf(c.uids.keep(events)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("about(%v) kept %v, want %v", c.uids, got, c.want)
		}
	}
}

// A drawer lists the events kubectl describe lists: those of the object it reads, not those of an earlier object of
// the same name, nor one naming no UID; a Node's also by its name, which the kubelet writes in place of the UID, and a
// mirror pod's by its static pod's UID.
func TestDescribeEventsAreThoseOfTheObjectsUID(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	api := &clusterDrawersAPI{
		objects: map[string]interface{}{
			"/apis/apps/v1/namespaces/shop/deployments/web": appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop", UID: "dep-now"}},
			"/api/v1/namespaces/shop/pods/web-0":            corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "web-0", Namespace: "shop", UID: "pod-now"}},
			"/api/v1/namespaces/kube-system/pods/etcd-cp": corev1.Pod{ObjectMeta: metav1.ObjectMeta{
				Name: "etcd-cp", Namespace: "kube-system", UID: "mirror-api-uid",
				Annotations: map[string]string{corev1.MirrorPodAnnotationKey: "static-hash"},
			}},
			"/api/v1/nodes/cp": corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "cp", UID: "node-uid"}},
		},
		events: []corev1.Event{
			withUID("dep-now", gatewayEvent("shop", "Deployment", "web", "ScalingReplicaSet", now)),
			withUID("dep-before", gatewayEvent("shop", "Deployment", "web", "OfTheOneBefore", now)),
			gatewayEvent("shop", "Deployment", "web", "NamesNoUID", now),
			withUID("pod-now", gatewayEvent("shop", "Pod", "web-0", "Pulled", now)),
			withUID("pod-before", gatewayEvent("shop", "Pod", "web-0", "BackOff", now)),
			withUID("static-hash", gatewayEvent("kube-system", "Pod", "etcd-cp", "Started", now)),
			withUID("mirror-api-uid", gatewayEvent("kube-system", "Pod", "etcd-cp", "ByTheAPIUID", now)),
			withUID("node-uid", gatewayEvent("default", "Node", "cp", "RegisteredNode", now.Add(-time.Minute))),
			withUID("cp", gatewayEvent("default", "Node", "cp", "NodeReady", now)),
			withUID("node-before", gatewayEvent("default", "Node", "cp", "OfTheOneBefore", now)),
		},
	}
	s := newClusterDrawersService(t, api)
	ctx := context.Background()
	describe := map[string]func() (map[string]interface{}, error){
		"Deployment": func() (map[string]interface{}, error) { return s.DescribeDeployment(ctx, "shop", "web") },
		"Pod":        func() (map[string]interface{}, error) { return s.DescribePod(ctx, "shop", "web-0") },
		"mirror Pod": func() (map[string]interface{}, error) { return s.DescribePod(ctx, "kube-system", "etcd-cp") },
		"Node":       func() (map[string]interface{}, error) { return s.DescribeNode(ctx, "cp") },
	}
	want := map[string][]string{
		"Deployment": {"ScalingReplicaSet"},
		"Pod":        {"Pulled"},
		"mirror Pod": {"Started"},
		"Node":       {"NodeReady", "RegisteredNode"},
	}
	for kind, read := range describe {
		out, err := read()
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if got := reasons(out); !reflect.DeepEqual(got, want[kind]) {
			t.Errorf("%s events = %v, want %v", kind, got, want[kind])
		}
	}
	nodeEvents, err := s.GetNodeEvents(ctx, "cp")
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, e := range nodeEvents {
		got = append(got, e["reason"].(string))
	}
	if !reflect.DeepEqual(got, []string{"NodeReady", "RegisteredNode"}) {
		t.Errorf("node events = %v, want those naming the node's UID or name", got)
	}
}
