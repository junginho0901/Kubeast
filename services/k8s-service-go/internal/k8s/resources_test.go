package k8s

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	fakediscovery "k8s.io/client-go/discovery/fake"
	fakedynamic "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func TestResolveCreateNamespace(t *testing.T) {
	cases := []struct {
		name       string
		yamlNs     string
		defaultNs  string
		namespaced bool
		want       string
	}{
		{"yaml ns 우선", "team-a", "team-b", true, "team-a"},
		{"yaml ns 없으면 default 인자 사용", "", "team-b", true, "team-b"},
		{"yaml/default 둘 다 없으면 default", "", "", true, "default"},
		{"cluster-scoped 는 항상 빈 문자열", "team-a", "team-b", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveCreateNamespace(tc.yamlNs, tc.defaultNs, tc.namespaced)
			if got != tc.want {
				t.Fatalf("resolveCreateNamespace(%q, %q, %v) = %q, want %q",
					tc.yamlNs, tc.defaultNs, tc.namespaced, got, tc.want)
			}
		})
	}
}

// CreateResourcesFromYAML 의 통합 테스트 — fake dynamic + discovery 로
// namespace 결정 로직이 실제 Create 호출에 어떻게 반영되는지 확인.
//
// 검증 포인트는 응답의 namespace 필드 — 이건 created.GetNamespace() 라
// fake dynamic 이 받은 namespace 그대로 노출. 따라서 응답 namespace 가
// 의도대로 셋되었는지로 = 내부에서 어떤 namespace 로 Create 가 호출됐는지
// 확인 가능.
func TestCreateResourcesFromYAML(t *testing.T) {
	cases := []struct {
		name      string
		yaml      string
		defaultNs string
		wantNs    string
	}{
		{
			name: "YAML 에 ns 있으면 그 값 사용",
			yaml: `apiVersion: v1
kind: Pod
metadata:
  name: p
  namespace: team-a
spec:
  containers:
    - name: c
      image: busybox`,
			defaultNs: "team-b",
			wantNs:    "team-a",
		},
		{
			name: "YAML 에 ns 없고 default 인자 있으면 그것 사용",
			yaml: `apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
    - name: c
      image: busybox`,
			defaultNs: "team-b",
			wantNs:    "team-b",
		},
		{
			name: "YAML/default 둘 다 없으면 default ns",
			yaml: `apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
    - name: c
      image: busybox`,
			defaultNs: "",
			wantNs:    "default",
		},
		{
			name: "cluster-scoped 리소스는 ns 무시 (빈 문자열)",
			yaml: `apiVersion: v1
kind: Namespace
metadata:
  name: my-ns`,
			defaultNs: "team-b",
			wantNs:    "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newServiceWithFakes(t)
			results, err := s.CreateResourcesFromYAML(context.Background(), tc.yaml, tc.defaultNs)
			if err != nil {
				t.Fatalf("CreateResourcesFromYAML: %v", err)
			}
			if len(results) != 1 {
				t.Fatalf("results = %d, want 1", len(results))
			}
			gotNs, _ := results[0]["namespace"].(string)
			if gotNs != tc.wantNs {
				t.Errorf("namespace = %q, want %q (kind=%v)", gotNs, tc.wantNs, results[0]["kind"])
			}
		})
	}
}

// newServiceWithFakes 는 fake dynamic + fake discovery 가 주입된 Service 를
// 반환. discovery 에는 pods (namespaced) 와 namespaces (cluster-scoped) 만
// 등록 — 테스트 케이스가 사용하는 두 kind 만으로 충분.
func newServiceWithFakes(t *testing.T) *Service {
	t.Helper()

	fakeCS := fake.NewSimpleClientset()
	fakeDiscovery := fakeCS.Discovery().(*fakediscovery.FakeDiscovery)
	fakeDiscovery.Resources = []*metav1.APIResourceList{
		{
			GroupVersion: "v1",
			APIResources: []metav1.APIResource{
				{Name: "pods", SingularName: "pod", Kind: "Pod", Namespaced: true},
				{Name: "namespaces", SingularName: "namespace", Kind: "Namespace", Namespaced: false},
			},
		},
	}

	scheme := runtime.NewScheme()
	fakeDyn := fakedynamic.NewSimpleDynamicClientWithCustomListKinds(
		scheme,
		map[schema.GroupVersionResource]string{
			{Group: "", Version: "v1", Resource: "pods"}:       "PodList",
			{Group: "", Version: "v1", Resource: "namespaces"}: "NamespaceList",
		},
	)

	s := &Service{}
	s.defaultBundle.Store(&clientBundle{
		dynamic:   fakeDyn,
		discovery: fakeDiscovery,
	})
	return s
}
