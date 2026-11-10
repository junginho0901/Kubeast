package k8s

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes"
	resourcehelper "k8s.io/component-helpers/resource"
)

// isNodePodList is a list of node's pods, as kubeast:cache or as a caller.
func isNodePodList(c apiCall, node string) bool {
	return c.verb == "list" && c.resource == "pods" && strings.HasPrefix(c.selector, "spec.nodeName="+node)
}

// Twenty different people opening one Node drawer at one moment read the node's pods for its Allocated Resources once
// for all of them, as kubeast:cache (and once more for those who came while it was under way), and none as themselves.
func TestTwentyPeopleOpeningOneNodeDrawerReadItsPodsOnceForAll(t *testing.T) {
	c := allocatedCases()[0]
	grants := map[string][]string{}
	for i := range 20 {
		grants[fmt.Sprintf("p%02d@example.com", i)] = []string{""}
	}
	api := &clusterAPI{pods: c.pods, review: rbac(grants), holdCache: make(chan struct{})}
	s, _ := api.start(t)
	answers := make([]map[string]interface{}, 20)
	errs := make([]error, 20)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers[i], errs[i] = s.DescribeNodeWithoutEvents(wideCaller(fmt.Sprintf("p%02d@example.com", i)), "n1")
		}()
	}
	asCallers := func() int {
		return api.count(func(c apiCall) bool { return isNodePodList(c, "n1") && c.user != overviewCacheUser })
	}
	eventually(t, 5*time.Second, func() bool { now, _ := api.cacheReads(); return now >= 1 || asCallers() >= 20 })
	time.Sleep(300 * time.Millisecond)
	close(api.holdCache)
	wg.Wait()
	shared := api.count(func(c apiCall) bool { return isNodePodList(c, "n1") && c.user == overviewCacheUser })
	t.Logf("20 people opening node n1 at once: %d lists of its pods as kubeast:cache, %d as the people", shared, asCallers())
	if got := asCallers(); got != 0 || shared < 1 || shared > 2 {
		t.Errorf("%d lists of the node's pods as the people and %d as kubeast:cache, want none and one or two", got, shared)
	}
	for i := range 20 {
		if errs[i] != nil {
			t.Fatalf("describe %d: %v", i, errs[i])
		}
		if got := allocatedRowsOf(t, answers[i]); !reflect.DeepEqual(got, c.want) {
			t.Errorf("person %d: %v\nwant %v", i, got, c.want)
		}
	}
}

// ownAllocated is what kubectl describe node adds up for a caller (getPodsTotalRequestsAndLimits): the pods on node not
// Succeeded or Failed, listed as the caller in each namespace of its grant or across the cluster, a namespace it is refused
// left out, each pod as k8s.io/component-helpers/resource counts it.
func ownAllocated(t *testing.T, ctx context.Context, cs kubernetes.Interface, node string) *allocatedTotals {
	t.Helper()
	opts := metav1.ListOptions{FieldSelector: fields.AndSelectors(
		fields.OneTermEqualSelector("spec.nodeName", node),
		fields.OneTermNotEqualSelector("status.phase", string(corev1.PodSucceeded)),
		fields.OneTermNotEqualSelector("status.phase", string(corev1.PodFailed)),
	).String()}
	tot := &allocatedTotals{requests: corev1.ResourceList{}, limits: corev1.ResourceList{}}
	sum := func(total, pod corev1.ResourceList) {
		for name, q := range pod {
			if have, ok := total[name]; ok {
				have.Add(q)
				total[name] = have
			} else {
				total[name] = q.DeepCopy()
			}
		}
	}
	err := eachCallerNamespace(ctx, "", func(namespace string) error {
		l, err := cs.CoreV1().Pods(namespace).List(ctx, opts)
		if err != nil {
			return err
		}
		for i := range l.Items {
			sum(tot.requests, resourcehelper.PodRequests(&l.Items[i], resourcehelper.PodResourcesOptions{}))
			sum(tot.limits, resourcehelper.PodLimits(&l.Items[i], resourcehelper.PodResourcesOptions{}))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("the caller's own list: %v", err)
	}
	return tot
}

// The Allocated Resources made from the node's shared read are what each person's own list adds up, kubectl's way, for
// every kind of pod (init containers at their peak, sidecars, overhead, pod-level resources, ended pods): for a person
// who may list pods everywhere, and for a grant limited to namespaces whose access check allows one, whose own RBAC
// lists another, and which is refused the third.
func TestAllocatedFromTheSharedReadIsWhatEachPersonsOwnListAddsUp(t *testing.T) {
	c := allocatedCases()[0]
	hidden := allocPod("c", "hidden", "n1", corev1.PodRunning, allocBox("app", resourceList("cpu", "3", "memory", "1Gi"), nil))
	pods := append(append([]corev1.Pod{}, c.pods...), hidden)
	api := &clusterAPI{pods: pods, review: rbac(map[string][]string{"wide@example.com": {""}, "limited@example.com": {"a"}})}
	api.may = func(user, verb, resource, namespace, _ string) bool {
		if user == overviewCacheUser || user == "wide@example.com" || resource == "nodes" {
			return true
		}
		return user == "limited@example.com" && (namespace == "a" || namespace == "b")
	}
	s, b := api.start(t)
	node := c.node
	for _, who := range []struct {
		name string
		ctx  context.Context
		want [][3]string
	}{
		{"may list pods everywhere", wideCaller("wide@example.com"), nil},
		{"a grant of a, b and c: a allowed, b listed as itself, c refused", grantCaller("limited@example.com", "a", "b", "c"), c.want},
	} {
		t.Run(who.name, func(t *testing.T) {
			out, err := s.DescribeNodeWithoutEvents(who.ctx, "n1")
			if err != nil {
				t.Fatal(err)
			}
			got := allocatedRowsOf(t, out)
			own := allocatedRows(&node, ownAllocated(t, who.ctx, b.clientset, "n1"))
			ownRows := allocatedRowsOf(t, map[string]interface{}{"allocated_resources": own})
			if !reflect.DeepEqual(got, ownRows) {
				t.Errorf("from the shared read %v\nits own list adds up %v", got, ownRows)
			}
			if who.want != nil && !reflect.DeepEqual(got, who.want) {
				t.Errorf("%v\nkubectl prints %v", got, who.want)
			}
		})
	}
}
