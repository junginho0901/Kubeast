package k8s

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/restmapper"
)

// orderedDiscovery answers discovery as kubectl's cached client does: the lists in the groups' order and each group's
// versions in its own order (client-go discovery.ServerGroupsAndResources without aggregated discovery).
type orderedDiscovery struct {
	discovery.DiscoveryInterface
	groups []*metav1.APIGroup
	lists  []*metav1.APIResourceList
}

func (d orderedDiscovery) ServerGroupsAndResources() ([]*metav1.APIGroup, []*metav1.APIResourceList, error) {
	return d.groups, d.lists, nil
}

// kubectlResource is the resource kubectl get takes a name for: cli-runtime v0.37.2 Builder.mappingFor over the mapper
// genericclioptions builds (a shortcut expander over the discovery RESTMapper), here without a disk cache.
func kubectlResource(d orderedDiscovery, arg string) (schema.GroupVersionResource, bool, error) {
	groupResources, err := restmapper.GetAPIGroupResources(d)
	if err != nil {
		return schema.GroupVersionResource{}, false, err
	}
	mapper := restmapper.NewShortcutExpander(restmapper.NewDiscoveryRESTMapper(groupResources), d, nil)
	fullySpecifiedGVR, groupResource := schema.ParseResourceArg(arg)
	gvk := schema.GroupVersionKind{}
	if fullySpecifiedGVR != nil {
		gvk, _ = mapper.KindFor(*fullySpecifiedGVR)
	}
	if gvk.Empty() {
		gvk, _ = mapper.KindFor(groupResource.WithVersion(""))
	}
	var mapping *meta.RESTMapping
	if !gvk.Empty() {
		mapping, err = mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	} else {
		_, groupKind := schema.ParseKindArg(arg)
		mapping, err = mapper.RESTMapping(groupKind)
	}
	if err != nil {
		return schema.GroupVersionResource{}, false, err
	}
	return mapping.Resource, mapping.Scope.Name() == meta.RESTScopeNameNamespace, nil
}

// shuffled is the lists as aggregated discovery gives them, in no fixed order.
func shuffled(r *rand.Rand, lists []*metav1.APIResourceList) []*metav1.APIResourceList {
	out := append([]*metav1.APIResourceList{nil}, lists...)
	r.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// sameAsKubectl holds matchResource over preferredFirst to kubectl for each name: the same resource where kubectl finds
// one, and where it finds none, no match or a match by kind only.
func sameAsKubectl(t *testing.T, d orderedDiscovery, lists []*metav1.APIResourceList, names []string) {
	t.Helper()
	ordered := preferredFirst(d.groups, lists)
	for _, name := range names {
		want, wantNamespaced, wantErr := kubectlResource(d, name)
		got, err := matchResource(ordered, name)
		if wantErr == nil {
			if err != nil || got.gvr != want || got.namespaced != wantNamespaced {
				t.Errorf("%q: Kubeast %v %v %v, kubectl %v %v", name, got.gvr, got.namespaced, err, want, wantNamespaced)
			}
			continue
		}
		if err == nil && !strings.EqualFold(got.kind, strings.SplitN(name, ".", 2)[0]) {
			t.Errorf("%q: kubectl finds none (%v), Kubeast %v not by kind", name, wantErr, got.gvr)
		}
	}
}

func discoveryGroup(name string, preferred string, versions ...string) *metav1.APIGroup {
	g := &metav1.APIGroup{Name: name}
	gv := func(v string) metav1.GroupVersionForDiscovery {
		return metav1.GroupVersionForDiscovery{GroupVersion: schema.GroupVersion{Group: name, Version: v}.String(), Version: v}
	}
	for _, v := range versions {
		g.Versions = append(g.Versions, gv(v))
	}
	g.PreferredVersion = gv(preferred)
	return g
}

func discoveryList(group, version string, resources ...metav1.APIResource) *metav1.APIResourceList {
	return &metav1.APIResourceList{GroupVersion: schema.GroupVersion{Group: group, Version: version}.String(), APIResources: resources}
}

func discoveryResource(plural, singular, kind string, namespaced bool, shortNames ...string) metav1.APIResource {
	return metav1.APIResource{Name: plural, SingularName: singular, Kind: kind, Namespaced: namespaced, ShortNames: shortNames}
}

// A name two groups serve is found where kubectl finds it: core v1 first, then the groups in discovery's order (the
// API server's priority, built-in groups before CRDs) whatever their names, a plural or singular before a short name,
// and never a subresource.
func TestMatchResourceFindsWhatKubectlFinds(t *testing.T) {
	groups := []*metav1.APIGroup{
		discoveryGroup("", "v1", "v1"),
		discoveryGroup("apps", "v1", "v1"),
		discoveryGroup("events.k8s.io", "v1", "v1"),
		discoveryGroup("autoscaling", "v2", "v2", "v1"),
		discoveryGroup("scheduling.k8s.io", "v1", "v1"),
		discoveryGroup("metrics.k8s.io", "v1beta1", "v1beta1"),
		// CRD groups after the built-in ones, in discovery's order whatever their names sort to
		discoveryGroup("alpha.example.com", "v1", "v2", "v1"),
		discoveryGroup("s3.services.k8s.aws", "v1alpha1", "v1alpha1"),
		discoveryGroup("s3.aws.upbound.io", "v1beta1", "v1beta1"),
	}
	lists := []*metav1.APIResourceList{
		discoveryList("", "v1",
			discoveryResource("pods", "pod", "Pod", true, "po"),
			discoveryResource("pods/log", "", "Pod", true),
			discoveryResource("events", "event", "Event", true, "ev"),
			discoveryResource("nodes", "node", "Node", false, "no"),
		),
		discoveryList("apps", "v1",
			discoveryResource("deployments", "deployment", "Deployment", true, "deploy"),
			discoveryResource("deployments/scale", "", "Scale", true),
		),
		discoveryList("events.k8s.io", "v1", discoveryResource("events", "event", "Event", true, "ev")),
		discoveryList("autoscaling", "v2", discoveryResource("horizontalpodautoscalers", "horizontalpodautoscaler", "HorizontalPodAutoscaler", true, "hpa")),
		discoveryList("autoscaling", "v1", discoveryResource("horizontalpodautoscalers", "horizontalpodautoscaler", "HorizontalPodAutoscaler", true, "hpa")),
		discoveryList("scheduling.k8s.io", "v1", discoveryResource("priorityclasses", "priorityclass", "PriorityClass", false, "pc")),
		discoveryList("metrics.k8s.io", "v1beta1",
			discoveryResource("pods", "", "PodMetrics", true),
			discoveryResource("nodes", "", "NodeMetrics", false),
		),
		discoveryList("alpha.example.com", "v2",
			discoveryResource("priorityclasses", "priorityclass", "PriorityClass", true, "pc"),
			discoveryResource("hpa", "hpa", "Hpa", true),
			discoveryResource("gizmos", "gizmoitem", "Gizmo", true),
		),
		discoveryList("alpha.example.com", "v1",
			discoveryResource("priorityclasses", "priorityclass", "PriorityClass", true, "pc"),
			discoveryResource("widgets", "widget", "Widget", true, "wd"),
		),
		discoveryList("s3.aws.upbound.io", "v1beta1", discoveryResource("buckets", "bucket", "Bucket", false)),
		discoveryList("s3.services.k8s.aws", "v1alpha1", discoveryResource("buckets", "bucket", "Bucket", true)),
	}
	d := orderedDiscovery{groups: groups, lists: lists}
	names := []string{
		"pods", "pod", "po", "Pods", "events", "ev", "nodes", "deployments", "deploy", "deploy.apps",
		"events.events.k8s.io", "horizontalpodautoscalers", "HorizontalPodAutoscaler", "priorityclasses", "pc",
		"pc.alpha.example.com", "hpa", "widgets", "wd", "widget", "buckets", "buckets.s3.services.k8s.aws",
		"scale", "log", "gizmo", "gizmoitem", "nothings",
	}
	sameAsKubectl(t, d, shuffled(rand.New(rand.NewPCG(1, 2)), lists), names)

	// where the order by group name took another: a CRD group before a built-in one, a short name before a plural, a
	// subresource's kind
	ordered := preferredFirst(groups, shuffled(rand.New(rand.NewPCG(3, 4)), lists))
	for name, want := range map[string]schema.GroupVersionResource{
		"priorityclasses": {Group: "scheduling.k8s.io", Version: "v1", Resource: "priorityclasses"},
		"pc":              {Group: "scheduling.k8s.io", Version: "v1", Resource: "priorityclasses"},
		"hpa":             {Group: "alpha.example.com", Version: "v2", Resource: "hpa"},
		"buckets":         {Group: "s3.services.k8s.aws", Version: "v1alpha1", Resource: "buckets"},
	} {
		if got, err := matchResource(ordered, name); err != nil || got.gvr != want {
			t.Errorf("%q = %v %v, want %v", name, got.gvr, err, want)
		}
	}
	if got, err := matchResource(ordered, "scale"); err == nil {
		t.Errorf(`"scale" = %v, want no match: deployments/scale is a subresource`, got.gvr)
	}
}

// The same over random discoveries: groups in a random order with random preferred versions, resources of one group
// served in some of its versions, names, singulars and short names shared between groups, the lists shuffled.
func TestMatchResourceFindsWhatKubectlFindsOverRandomDiscovery(t *testing.T) {
	r := rand.New(rand.NewPCG(20261113, 1))
	stems := []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot"}
	shorts := []string{"al", "br", "ch", "de", "ec", "fo", "alphas"}
	for run := 0; run < 300; run++ {
		var groups []*metav1.APIGroup
		var lists []*metav1.APIResourceList
		var names []string
		groupNames := []string{"", "apps", "one.example.com", "two.example.com", "three.example.org"}
		r.Shuffle(len(groupNames)-1, func(i, j int) { groupNames[i+1], groupNames[j+1] = groupNames[j+1], groupNames[i+1] })
		for _, group := range groupNames {
			versions := []string{"v1"}
			if group != "" {
				versions = []string{"v2", "v1", "v1beta1"}[:1+r.IntN(3)]
			}
			groups = append(groups, discoveryGroup(group, versions[r.IntN(len(versions))], versions...))
			byVersion := map[string][]metav1.APIResource{}
			usedShort := map[string]bool{}
			for _, i := range r.Perm(len(stems))[:1+r.IntN(3)] {
				stem := stems[i]
				res := discoveryResource(stem+"s", stem, strings.ToUpper(stem[:1])+stem[1:], r.IntN(2) == 0)
				if r.IntN(4) == 0 {
					res.SingularName = "" // a server that lists none
				}
				if short := shorts[r.IntN(len(shorts))]; r.IntN(2) == 0 && !usedShort[short] && short != res.Name {
					res.ShortNames = []string{short}
					usedShort[short] = true
				}
				for _, v := range versions {
					if v == versions[0] || r.IntN(2) == 0 {
						byVersion[v] = append(byVersion[v], res)
					}
				}
				names = append(names, res.Name, stem, res.Kind)
			}
			for _, v := range versions {
				if rs := byVersion[v]; len(rs) > 0 {
					lists = append(lists, discoveryList(group, v, rs...))
				}
			}
		}
		names = append(names, shorts...)
		t.Run(fmt.Sprint(run), func(t *testing.T) {
			sameAsKubectl(t, orderedDiscovery{groups: groups, lists: lists}, shuffled(r, lists), names)
		})
	}
}
