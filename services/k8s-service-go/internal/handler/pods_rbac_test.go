package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// The Cluster View's RBAC tab draws this file's answers; its test (podRbac.cases.test.ts) runs the tab over them.
const podRBACCasesFile = "../../../../frontend/src/pages/cluster-view/podRbac.cases.json"

const (
	rbacGroupVersion = "rbac.authorization.k8s.io/v1"
	rbacGroup        = "rbac.authorization.k8s.io"
	rbacCaller       = "dev@example.com"
	fakeSecretValue  = "not-a-real-secret-value"
)

// rbacCluster answers what the route reads at the API server's paths and JSON, as one identity the cluster may refuse.
type rbacCluster struct {
	mu         sync.Mutex
	objects    map[string]interface{}
	refused    map[string]bool
	asked      []string
	identities []string
	groups     [][]string
}

func (c *rbacCluster) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	c.asked = append(c.asked, r.Method+" "+r.URL.Path)
	c.identities = append(c.identities, r.Header.Get(auth.HeaderImpersonateUser))
	c.groups = append(c.groups, r.Header.Values(auth.HeaderImpersonateGroup))
	c.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	status := func(code int, reason, message string) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: "Failure", Reason: metav1.StatusReason(reason), Code: int32(code), Message: message})
	}
	switch o, ok := c.objects[r.URL.Path]; {
	case c.refused[r.URL.Path]:
		status(http.StatusForbidden, "Forbidden", r.URL.Path+" is forbidden for this identity")
	case ok:
		_ = json.NewEncoder(w).Encode(o)
	default:
		status(http.StatusNotFound, "NotFound", r.URL.Path+" not found")
	}
}

func (c *rbacCluster) askedFor(path string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, a := range c.asked {
		if a == "GET "+path {
			n++
		}
	}
	return n
}

func podPath(ns, name string) string { return "/api/v1/namespaces/" + ns + "/pods/" + name }
func saPath(ns, name string) string  { return "/api/v1/namespaces/" + ns + "/serviceaccounts/" + name }
func roleBindingsPath(ns string) string {
	return "/apis/" + rbacGroupVersion + "/namespaces/" + ns + "/rolebindings"
}
func rolePath(ns, name string) string {
	return "/apis/" + rbacGroupVersion + "/namespaces/" + ns + "/roles/" + name
}
func clusterRolePath(name string) string {
	return "/apis/" + rbacGroupVersion + "/clusterroles/" + name
}

const clusterRoleBindingsPath = "/apis/" + rbacGroupVersion + "/clusterrolebindings"

var rbacCreated = metav1.NewTime(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))

func serviceAccountSubject(ns, name string) rbacv1.Subject {
	return rbacv1.Subject{Kind: "ServiceAccount", Name: name, Namespace: ns}
}
func userSubject(name string) rbacv1.Subject {
	return rbacv1.Subject{Kind: "User", APIGroup: rbacGroup, Name: name}
}
func groupSubject(name string) rbacv1.Subject {
	return rbacv1.Subject{Kind: "Group", APIGroup: rbacGroup, Name: name}
}

func roleBinding(ns, name, roleKind, role string, subjects ...rbacv1.Subject) rbacv1.RoleBinding {
	return rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, CreationTimestamp: rbacCreated},
		Subjects:   subjects,
		RoleRef:    rbacv1.RoleRef{APIGroup: rbacGroup, Kind: roleKind, Name: role},
	}
}

func clusterRoleBinding(name, role string, subjects ...rbacv1.Subject) rbacv1.ClusterRoleBinding {
	return rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: name, CreationTimestamp: rbacCreated},
		Subjects:   subjects,
		RoleRef:    rbacv1.RoleRef{APIGroup: rbacGroup, Kind: "ClusterRole", Name: role},
	}
}

// newRBACCluster holds pod shop/web-1 of ServiceAccount web-sa, whose token Secret carries a value no answer may hold,
// the roles of the cases and no binding: withBindings adds those.
func newRBACCluster() *rbacCluster {
	c := &rbacCluster{objects: map[string]interface{}{}, refused: map[string]bool{}}
	c.objects[podPath("shop", "web-1")] = corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "web-1", Namespace: "shop"},
		Spec:       corev1.PodSpec{ServiceAccountName: "web-sa"},
	}
	c.objects[saPath("shop", "web-sa")] = corev1.ServiceAccount{
		TypeMeta:   metav1.TypeMeta{Kind: "ServiceAccount", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "web-sa", Namespace: "shop", Labels: map[string]string{"app": "web"}},
		Secrets:    []corev1.ObjectReference{{Name: "web-sa-token"}},
	}
	c.objects["/api/v1/namespaces/shop/secrets/web-sa-token"] = corev1.Secret{
		TypeMeta:   metav1.TypeMeta{Kind: "Secret", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "web-sa-token", Namespace: "shop"},
		Data:       map[string][]byte{"token": []byte(fakeSecretValue)},
	}
	c.objects[rolePath("shop", "web-reader")] = rbacv1.Role{
		TypeMeta:   metav1.TypeMeta{Kind: "Role", APIVersion: rbacGroupVersion},
		ObjectMeta: metav1.ObjectMeta{Name: "web-reader", Namespace: "shop"},
		Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{""}, Resources: []string{"configmaps"}, ResourceNames: []string{"app-config", "app-flags"}, Verbs: []string{"get"}},
			{APIGroups: []string{"apps"}, Resources: []string{"deployments", "deployments/scale"}, Verbs: []string{"list", "get"}},
			{APIGroups: []string{"", "batch"}, Resources: []string{"events"}, Verbs: []string{"list"}},
		},
	}
	clusterRole := func(name string, rules ...rbacv1.PolicyRule) {
		c.objects[clusterRolePath(name)] = rbacv1.ClusterRole{
			TypeMeta:   metav1.TypeMeta{Kind: "ClusterRole", APIVersion: rbacGroupVersion},
			ObjectMeta: metav1.ObjectMeta{Name: name},
			Rules:      rules,
		}
	}
	clusterRole("pod-looker", rbacv1.PolicyRule{APIGroups: []string{""}, Resources: []string{"pods", "pods/log"}, Verbs: []string{"get"}})
	clusterRole("node-looker",
		rbacv1.PolicyRule{APIGroups: []string{""}, Resources: []string{"nodes"}, Verbs: []string{"get", "list"}},
		rbacv1.PolicyRule{NonResourceURLs: []string{"/healthz", "/metrics"}, Verbs: []string{"get"}})
	clusterRole("account-reader", rbacv1.PolicyRule{NonResourceURLs: []string{"/openid/v1/jwks"}, Verbs: []string{"get"}})
	clusterRole("basic-user",
		rbacv1.PolicyRule{APIGroups: []string{"authorization.k8s.io"}, Resources: []string{"selfsubjectaccessreviews"}, Verbs: []string{"create"}},
		rbacv1.PolicyRule{NonResourceURLs: []string{"/version"}, Verbs: []string{"get"}})
	clusterRole("empty-role")
	clusterRole("cluster-admin", rbacv1.PolicyRule{APIGroups: []string{"*"}, Resources: []string{"*"}, Verbs: []string{"*"}})
	c.setBindings(nil, nil)
	return c
}

func (c *rbacCluster) setBindings(rbs []rbacv1.RoleBinding, crbs []rbacv1.ClusterRoleBinding) {
	c.objects[roleBindingsPath("shop")] = rbacv1.RoleBindingList{TypeMeta: metav1.TypeMeta{Kind: "RoleBindingList", APIVersion: rbacGroupVersion}, Items: rbs}
	c.objects[clusterRoleBindingsPath] = rbacv1.ClusterRoleBindingList{TypeMeta: metav1.TypeMeta{Kind: "ClusterRoleBindingList", APIVersion: rbacGroupVersion}, Items: crbs}
}

// withBindings binds web-sa in each way the API server matches it, beside bindings of other subjects.
func (c *rbacCluster) withBindings() *rbacCluster {
	c.setBindings([]rbacv1.RoleBinding{
		roleBinding("shop", "web-rb", "Role", "web-reader", serviceAccountSubject("shop", "web-sa")),
		// A RoleBinding's ServiceAccount subject without a namespace is one of the binding's namespace.
		roleBinding("shop", "bare-subject-rb", "ClusterRole", "pod-looker", rbacv1.Subject{Kind: "ServiceAccount", Name: "web-sa"}),
		roleBinding("shop", "namespace-group-rb", "ClusterRole", "pod-looker", groupSubject("system:serviceaccounts:shop")),
		roleBinding("shop", "other-account-rb", "ClusterRole", "cluster-admin", serviceAccountSubject("shop", "other-sa")),
		roleBinding("shop", "other-namespace-rb", "ClusterRole", "cluster-admin", serviceAccountSubject("payments", "web-sa")),
		roleBinding("shop", "other-namespace-group-rb", "ClusterRole", "cluster-admin", groupSubject("system:serviceaccounts:payments")),
	}, []rbacv1.ClusterRoleBinding{
		clusterRoleBinding("web-crb", "node-looker", serviceAccountSubject("shop", "web-sa")),
		clusterRoleBinding("user-crb", "node-looker", userSubject("system:serviceaccount:shop:web-sa")),
		clusterRoleBinding("all-accounts-crb", "account-reader", groupSubject("system:serviceaccounts")),
		clusterRoleBinding("everyone-crb", "basic-user", groupSubject("system:authenticated")),
		clusterRoleBinding("account-and-everyone-crb", "account-reader", serviceAccountSubject("shop", "web-sa"), groupSubject("system:authenticated")),
		clusterRoleBinding("alice-crb", "cluster-admin", userSubject("alice")),
		clusterRoleBinding("anonymous-crb", "cluster-admin", groupSubject("system:unauthenticated")),
		// The API server requires a namespace here, and does not match a subject without one.
		clusterRoleBinding("bare-subject-crb", "cluster-admin", rbacv1.Subject{Kind: "ServiceAccount", Name: "web-sa"}),
	})
	return c
}

func rbacTestPayload() auth.TokenPayload {
	return auth.TokenPayload{UserID: "u1", Email: rbacCaller, Roles: map[string]string{"c": "Read"}}
}

// askPodRBAC serves one request through the route as main.go wires it: the caller, then the namespace scope.
func askPodRBAC(t *testing.T, c *rbacCluster, payload auth.TokenPayload, target string) (int, map[string]interface{}, string) {
	t.Helper()
	api := httptest.NewServer(c)
	t.Cleanup(api.Close)
	blob := strings.Replace(middlewareKubeconfig, "https://127.0.0.1:6443", api.URL, 1)
	svc, err := k8s.NewService(context.Background(), canIRegistry{blob: blob}, false, nil, k8s.ServiceOptions{Impersonation: true})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{svc: svc}
	router := chi.NewRouter()
	router.Group(func(g chi.Router) {
		g.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				next.ServeHTTP(w, r.WithContext(auth.WithPayload(cluster.WithID(r.Context(), "c"), payload)))
			})
		})
		g.Use(h.NamespaceScopeMiddleware)
		g.Get("/api/v1/namespaces/{namespace}/pods/{name}/rbac", h.GetPodRBAC)
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Body.String()
}

const webPodRoute = "/api/v1/namespaces/shop/pods/web-1/rbac"

func rowsOf(answer map[string]interface{}, key string) map[string]map[string]interface{} {
	out := map[string]map[string]interface{}{}
	rows, _ := answer[key].([]interface{})
	for _, r := range rows {
		row, _ := r.(map[string]interface{})
		name, _ := row["name"].(string)
		out[name] = row
	}
	return out
}

func namesOf(answer map[string]interface{}, key string) []string {
	names := []string{}
	for name := range rowsOf(answer, key) {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func reasonsOf(row map[string]interface{}) []string {
	reasons := []string{}
	matched, _ := row["matched_by"].([]interface{})
	for _, m := range matched {
		entry, _ := m.(map[string]interface{})
		reason, _ := entry["reason"].(string)
		reasons = append(reasons, reason)
	}
	return reasons
}

func decodedJSON(t *testing.T, text string) interface{} {
	t.Helper()
	var out interface{}
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("%v: %s", err, text)
	}
	return out
}

func TestPodRBAC_AnswersWhatTheTabReads(t *testing.T) {
	status, answer, body := askPodRBAC(t, newRBACCluster().withBindings(), rbacTestPayload(), webPodRoute)
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	if got, want := answer["service_account"], decodedJSON(t, `{"name":"web-sa","namespace":"shop"}`); !reflect.DeepEqual(got, want) {
		t.Errorf("service_account = %v, want %v", got, want)
	}
	if got, want := answer["pod"], decodedJSON(t, `{"name":"web-1","namespace":"shop"}`); !reflect.DeepEqual(got, want) {
		t.Errorf("pod = %v, want %v", got, want)
	}
	if got, want := rowsOf(answer, "role_bindings")["web-rb"], decodedJSON(t, `{
		"name":"web-rb","namespace":"shop","created_at":"2026-01-02T03:04:05Z","is_broad":false,
		"subjects":[{"kind":"ServiceAccount","api_group":"","name":"web-sa","namespace":"shop"}],
		"matched_by":[{"reason":"serviceaccount","broad":false,"subject":{"kind":"ServiceAccount","api_group":"","name":"web-sa","namespace":"shop"}}],
		"role_ref":{"api_group":"rbac.authorization.k8s.io","kind":"Role","name":"web-reader"},
		"resolved_role":{"api_group":"rbac.authorization.k8s.io","kind":"Role","name":"web-reader","rules":[
			{"verbs":["get"],"api_groups":[""],"resources":["configmaps"],"resource_names":["app-config","app-flags"],"non_resource_urls":[]},
			{"verbs":["list","get"],"api_groups":["apps"],"resources":["deployments","deployments/scale"],"resource_names":[],"non_resource_urls":[]},
			{"verbs":["list"],"api_groups":["","batch"],"resources":["events"],"resource_names":[],"non_resource_urls":[]}]}}`); !reflect.DeepEqual(asAny(got), want) {
		t.Errorf("web-rb = %v, want %v", got, want)
	}
	if got, want := rowsOf(answer, "cluster_role_bindings")["web-crb"]["resolved_role"], decodedJSON(t, `{"api_group":"rbac.authorization.k8s.io","kind":"ClusterRole","name":"node-looker","rules":[
			{"verbs":["get","list"],"api_groups":[""],"resources":["nodes"],"resource_names":[],"non_resource_urls":[]},
			{"verbs":["get"],"api_groups":[],"resources":[],"resource_names":[],"non_resource_urls":["/healthz","/metrics"]}]}`); !reflect.DeepEqual(got, want) {
		t.Errorf("web-crb's role = %v, want %v", got, want)
	}
	if got, ok := answer["errors"].([]interface{}); !ok || len(got) != 0 {
		t.Errorf("errors = %v, want an empty list", answer["errors"])
	}
}

func asAny(row map[string]interface{}) interface{} { return row }

func TestPodRBAC_KeepsTheFieldsItAnsweredBefore(t *testing.T) {
	_, answer, _ := askPodRBAC(t, newRBACCluster().withBindings(), rbacTestPayload(), webPodRoute)
	for key, want := range map[string]interface{}{
		"pod_name":               "web-1",
		"namespace":              "shop",
		"service_account_name":   "web-sa",
		"service_account_labels": map[string]interface{}{"app": "web"},
		"secrets":                []interface{}{"web-sa-token"},
	} {
		if !reflect.DeepEqual(answer[key], want) {
			t.Errorf("%s = %v, want %v", key, answer[key], want)
		}
	}
	bindings, _ := answer["bindings"].([]interface{})
	want := []interface{}{
		decodedJSON(t, `{"binding_type":"RoleBinding","binding_name":"web-rb","role_kind":"Role","role_name":"web-reader"}`),
		decodedJSON(t, `{"binding_type":"ClusterRoleBinding","binding_name":"web-crb","role_kind":"ClusterRole","role_name":"node-looker"}`),
	}
	for _, row := range want {
		if !slices.ContainsFunc(bindings, func(b interface{}) bool { return reflect.DeepEqual(b, row) }) {
			t.Errorf("bindings = %v, want a row %v", bindings, row)
		}
	}
}

// The API server's rules for a ServiceAccount's user name and groups, for both kinds of binding.
func TestPodRBAC_MatchesASubjectAsTheAPIServerDoes(t *testing.T) {
	_, answer, _ := askPodRBAC(t, newRBACCluster().withBindings(), rbacTestPayload(), webPodRoute)
	if got, want := namesOf(answer, "role_bindings"), []string{"bare-subject-rb", "namespace-group-rb", "web-rb"}; !reflect.DeepEqual(got, want) {
		t.Errorf("role_bindings = %v, want %v", got, want)
	}
	if got, want := namesOf(answer, "cluster_role_bindings"), []string{"account-and-everyone-crb", "all-accounts-crb", "user-crb", "web-crb"}; !reflect.DeepEqual(got, want) {
		t.Errorf("cluster_role_bindings = %v, want %v", got, want)
	}
	for key, rows := range map[string]map[string][]string{
		"role_bindings": {
			"web-rb":             {"serviceaccount"},
			"bare-subject-rb":    {"serviceaccount"},
			"namespace-group-rb": {"group:serviceaccounts:namespace"},
		},
		"cluster_role_bindings": {
			"web-crb":                  {"serviceaccount"},
			"user-crb":                 {"user:system:serviceaccount"},
			"all-accounts-crb":         {"group:serviceaccounts"},
			"account-and-everyone-crb": {"serviceaccount"},
		},
	} {
		for name, want := range rows {
			if got := reasonsOf(rowsOf(answer, key)[name]); !reflect.DeepEqual(got, want) {
				t.Errorf("%s %s matched by %v, want %v", key, name, got, want)
			}
		}
	}
}

func TestPodRBAC_IncludeAuthenticatedAddsThatGroupsBindings(t *testing.T) {
	status, answer, body := askPodRBAC(t, newRBACCluster().withBindings(), rbacTestPayload(), webPodRoute+"?include_authenticated=true")
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	rows := rowsOf(answer, "cluster_role_bindings")
	if got, want := reasonsOf(rows["everyone-crb"]), []string{"group:system:authenticated"}; !reflect.DeepEqual(got, want) {
		t.Errorf("everyone-crb matched by %v, want %v", got, want)
	}
	if rows["everyone-crb"]["is_broad"] != true {
		t.Errorf("everyone-crb is_broad = %v, want true", rows["everyone-crb"]["is_broad"])
	}
	// Bound by name too: not only the broad group.
	both := rows["account-and-everyone-crb"]
	if got, want := reasonsOf(both), []string{"serviceaccount", "group:system:authenticated"}; !reflect.DeepEqual(got, want) {
		t.Errorf("account-and-everyone-crb matched by %v, want %v", got, want)
	}
	if both["is_broad"] != false {
		t.Errorf("account-and-everyone-crb is_broad = %v, want false", both["is_broad"])
	}
	if answer["include_authenticated"] != true {
		t.Errorf("include_authenticated = %v, want true", answer["include_authenticated"])
	}
	if _, plain, _ := askPodRBAC(t, newRBACCluster().withBindings(), rbacTestPayload(), webPodRoute); rowsOf(plain, "cluster_role_bindings")["everyone-crb"] != nil || plain["include_authenticated"] != false {
		t.Errorf("without the flag: %v, include_authenticated = %v", namesOf(plain, "cluster_role_bindings"), plain["include_authenticated"])
	}
}

// What the cluster refuses is named beside what it gave, and what was not read is not an empty list.
func TestPodRBAC_NamesWhatTheClusterRefused(t *testing.T) {
	refused := func(paths ...string) (int, map[string]interface{}, string) {
		c := newRBACCluster().withBindings()
		for _, p := range paths {
			c.refused[p] = true
		}
		return askPodRBAC(t, c, rbacTestPayload(), webPodRoute)
	}
	hasError := func(answer map[string]interface{}, part string) bool {
		list, _ := answer["errors"].([]interface{})
		return slices.ContainsFunc(list, func(e interface{}) bool {
			text, _ := e.(string)
			return strings.Contains(text, part)
		})
	}

	t.Run("ClusterRoleBindings", func(t *testing.T) {
		status, answer, body := refused(clusterRoleBindingsPath)
		if status != http.StatusOK {
			t.Fatalf("status %d: %s", status, body)
		}
		if _, listed := answer["cluster_role_bindings"]; listed {
			t.Errorf("cluster_role_bindings = %v, want no list", answer["cluster_role_bindings"])
		}
		if text, _ := answer["cluster_role_bindings_error"].(string); !strings.Contains(text, "forbidden") {
			t.Errorf("cluster_role_bindings_error = %q", text)
		}
		if !hasError(answer, "cluster role bindings") {
			t.Errorf("errors = %v", answer["errors"])
		}
		if got := namesOf(answer, "role_bindings"); len(got) != 3 {
			t.Errorf("role_bindings = %v, want what was read", got)
		}
	})

	t.Run("RoleBindings", func(t *testing.T) {
		status, answer, body := refused(roleBindingsPath("shop"))
		if status != http.StatusOK {
			t.Fatalf("status %d: %s", status, body)
		}
		if _, listed := answer["role_bindings"]; listed {
			t.Errorf("role_bindings = %v, want no list", answer["role_bindings"])
		}
		if text, _ := answer["role_bindings_error"].(string); !strings.Contains(text, "forbidden") {
			t.Errorf("role_bindings_error = %q", text)
		}
		if got := namesOf(answer, "cluster_role_bindings"); len(got) != 4 {
			t.Errorf("cluster_role_bindings = %v, want what was read", got)
		}
	})

	t.Run("the ServiceAccount", func(t *testing.T) {
		status, answer, body := refused(saPath("shop", "web-sa"))
		if status != http.StatusOK {
			t.Fatalf("status %d: %s", status, body)
		}
		if got := answer["service_account_name"]; got != "web-sa" {
			t.Errorf("service_account_name = %v, the pod's", got)
		}
		for _, key := range []string{"secrets", "service_account_labels"} {
			if _, there := answer[key]; there {
				t.Errorf("%s = %v, want it left out", key, answer[key])
			}
		}
		if text, _ := answer["service_account_error"].(string); !strings.Contains(text, "forbidden") {
			t.Errorf("service_account_error = %q", text)
		}
		if got := namesOf(answer, "role_bindings"); len(got) != 3 {
			t.Errorf("role_bindings = %v", got)
		}
	})

	t.Run("a ClusterRole", func(t *testing.T) {
		status, answer, body := refused(clusterRolePath("node-looker"))
		if status != http.StatusOK {
			t.Fatalf("status %d: %s", status, body)
		}
		for _, name := range []string{"web-crb", "user-crb"} {
			role, _ := rowsOf(answer, "cluster_role_bindings")[name]["resolved_role"].(map[string]interface{})
			if text, _ := role["error"].(string); !strings.Contains(text, "forbidden") {
				t.Errorf("%s: resolved_role.error = %q", name, text)
			}
			if rules, ok := role["rules"].([]interface{}); !ok || len(rules) != 0 {
				t.Errorf("%s: rules = %v, want an empty list", name, role["rules"])
			}
		}
		list, _ := answer["errors"].([]interface{})
		if n := len(list); n != 1 {
			t.Errorf("errors = %v, want the role named once", list)
		}
		if !hasError(answer, "node-looker") {
			t.Errorf("errors = %v", list)
		}
	})

	t.Run("the pod", func(t *testing.T) {
		if status, _, body := refused(podPath("shop", "web-1")); status != http.StatusForbidden {
			t.Errorf("status %d: %s", status, body)
		}
	})
}

func TestPodRBAC_NamesWhatDoesNotExist(t *testing.T) {
	c := newRBACCluster()
	c.setBindings([]rbacv1.RoleBinding{roleBinding("shop", "dangling-rb", "Role", "no-such-role", serviceAccountSubject("shop", "web-sa"))}, nil)
	delete(c.objects, saPath("shop", "web-sa"))
	status, answer, body := askPodRBAC(t, c, rbacTestPayload(), webPodRoute)
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	if text, _ := answer["service_account_error"].(string); !strings.Contains(text, "not found") {
		t.Errorf("service_account_error = %q", text)
	}
	role, _ := rowsOf(answer, "role_bindings")["dangling-rb"]["resolved_role"].(map[string]interface{})
	if text, _ := role["error"].(string); !strings.Contains(text, "not found") {
		t.Errorf("resolved_role.error = %q", text)
	}
	if status, _, body := askPodRBAC(t, newRBACCluster(), rbacTestPayload(), "/api/v1/namespaces/shop/pods/no-such-pod/rbac"); status != http.StatusNotFound {
		t.Errorf("a missing pod: status %d: %s", status, body)
	}
}

func TestPodRBAC_ReadsEachRoleOnce(t *testing.T) {
	c := newRBACCluster().withBindings()
	askPodRBAC(t, c, rbacTestPayload(), webPodRoute)
	if n := c.askedFor(clusterRolePath("node-looker")); n != 1 {
		t.Errorf("node-looker read %d times, want 1", n)
	}
	if n := c.askedFor(clusterRolePath("cluster-admin")); n != 0 {
		t.Errorf("a role no matched binding names was read %d times", n)
	}
}

func TestPodRBAC_ReadsAsTheCaller(t *testing.T) {
	c := newRBACCluster().withBindings()
	askPodRBAC(t, c, rbacTestPayload(), webPodRoute)
	if len(c.identities) < 5 {
		t.Fatalf("asked %v", c.asked)
	}
	for i, identity := range c.identities {
		if identity != rbacCaller {
			t.Errorf("%s as %q, want the caller", c.asked[i], identity)
		}
	}
}

// A grant limited to namespaces reads no more than its identity may: the namespace it holds, and nothing of a list the
// cluster refuses it. Outside its namespaces nothing reaches the cluster.
func TestPodRBAC_AGrantLimitedToANamespaceSeesWhatTheClusterGivesIt(t *testing.T) {
	limited := rbacTestPayload()
	limited.Namespaces = map[string][]string{"c": {"shop"}}

	other := newRBACCluster().withBindings()
	if status, _, body := askPodRBAC(t, other, limited, "/api/v1/namespaces/payments/pods/web-1/rbac"); status != http.StatusForbidden {
		t.Errorf("another namespace: status %d: %s", status, body)
	}
	if len(other.asked) != 0 {
		t.Errorf("another namespace reached the cluster: %v", other.asked)
	}

	c := newRBACCluster().withBindings()
	c.refused[roleBindingsPath("shop")] = true
	c.refused[clusterRoleBindingsPath] = true
	status, answer, body := askPodRBAC(t, c, limited, webPodRoute)
	if status != http.StatusOK {
		t.Fatalf("status %d: %s", status, body)
	}
	for _, g := range c.groups {
		if !slices.Contains(g, "kubeast:role:read") {
			t.Errorf("asked with groups %v, want the limited grant's", g)
		}
	}
	if got := answer["service_account_name"]; got != "web-sa" {
		t.Errorf("service_account_name = %v", got)
	}
	for _, name := range []string{"role_bindings", "cluster_role_bindings"} {
		if _, listed := answer[name]; listed {
			t.Errorf("%s = %v", name, answer[name])
		}
	}
	if rows, ok := answer["bindings"].([]interface{}); !ok || len(rows) != 0 {
		t.Errorf("bindings = %v, want an empty list", answer["bindings"])
	}
	for _, hidden := range []string{"web-reader", "node-looker", "alice"} {
		if strings.Contains(body, hidden) {
			t.Errorf("the answer has %q: %s", hidden, body)
		}
	}
}

func TestPodRBAC_NamesSecretsAndNeverReadsThem(t *testing.T) {
	c := newRBACCluster().withBindings()
	_, answer, body := askPodRBAC(t, c, rbacTestPayload(), webPodRoute+"?include_authenticated=true")
	if got, want := answer["secrets"], []interface{}{"web-sa-token"}; !reflect.DeepEqual(got, want) {
		t.Errorf("secrets = %v, want %v", got, want)
	}
	if strings.Contains(body, fakeSecretValue) {
		t.Errorf("the answer holds a Secret's value: %s", body)
	}
	for _, asked := range c.asked {
		if strings.Contains(asked, "/secrets") {
			t.Errorf("read %s", asked)
		}
	}
}

// podRBACWant is what the tab must draw for a case's answer, written here by hand: rows of the permission summary in
// the tab's order, "apiGroup|resource|names|verbs" and "url|verbs"; a list's names, or null where it was not read.
type podRBACWant struct {
	ServiceAccount      string   `json:"service_account"`
	RoleBindings        []string `json:"role_bindings"`
	ClusterRoleBindings []string `json:"cluster_role_bindings"`
	Resources           []string `json:"resources"`
	NonResources        []string `json:"non_resources"`
	Incomplete          bool     `json:"incomplete"`
	Warnings            int      `json:"warnings"`
}

type podRBACCase struct {
	Name                 string          `json:"name"`
	IncludeAuthenticated bool            `json:"include_authenticated"`
	Answer               json.RawMessage `json:"answer"`
	Want                 podRBACWant     `json:"want"`
}

func podRBACCases(t *testing.T) []podRBACCase {
	t.Helper()
	answer := func(c *rbacCluster, target string) json.RawMessage {
		_, _, body := askPodRBAC(t, c, rbacTestPayload(), target)
		return json.RawMessage(body)
	}
	refusedBindings := newRBACCluster().withBindings()
	refusedBindings.refused[clusterRoleBindingsPath] = true
	refusedBindings.refused[clusterRolePath("pod-looker")] = true
	refusedLists := newRBACCluster().withBindings()
	refusedLists.refused[roleBindingsPath("shop")] = true
	refusedLists.refused[clusterRoleBindingsPath] = true
	refusedRole := newRBACCluster().withBindings()
	refusedRole.refused[clusterRolePath("pod-looker")] = true

	emptyRole := newRBACCluster()
	emptyRole.setBindings(nil, []rbacv1.ClusterRoleBinding{clusterRoleBinding("empty-crb", "empty-role", serviceAccountSubject("shop", "web-sa"))})

	return []podRBACCase{
		{
			Name:   "bound by name, by user name and by group",
			Answer: answer(newRBACCluster().withBindings(), webPodRoute),
			Want: podRBACWant{
				ServiceAccount:      "web-sa",
				RoleBindings:        []string{"bare-subject-rb", "namespace-group-rb", "web-rb"},
				ClusterRoleBindings: []string{"account-and-everyone-crb", "all-accounts-crb", "user-crb", "web-crb"},
				Resources: []string{
					"(core)|configmaps|app-config,app-flags|get",
					"(core)|events||list",
					"(core)|nodes||get,list",
					"(core)|pods||get",
					"(core)|pods/log||get",
					"apps|deployments||get,list",
					"apps|deployments/scale||get,list",
					"batch|events||list",
				},
				NonResources: []string{"/healthz|get", "/metrics|get", "/openid/v1/jwks|get"},
			},
		},
		{
			Name:                 "with the broad group",
			IncludeAuthenticated: true,
			Answer:               answer(newRBACCluster().withBindings(), webPodRoute+"?include_authenticated=true"),
			Want: podRBACWant{
				ServiceAccount:      "web-sa",
				RoleBindings:        []string{"bare-subject-rb", "namespace-group-rb", "web-rb"},
				ClusterRoleBindings: []string{"account-and-everyone-crb", "all-accounts-crb", "everyone-crb", "user-crb", "web-crb"},
				Resources: []string{
					"(core)|configmaps|app-config,app-flags|get",
					"(core)|events||list",
					"(core)|nodes||get,list",
					"(core)|pods||get",
					"(core)|pods/log||get",
					"apps|deployments||get,list",
					"apps|deployments/scale||get,list",
					"authorization.k8s.io|selfsubjectaccessreviews||create",
					"batch|events||list",
				},
				NonResources: []string{"/healthz|get", "/metrics|get", "/openid/v1/jwks|get", "/version|get"},
			},
		},
		{
			Name:   "no binding names the account",
			Answer: answer(newRBACCluster(), webPodRoute),
			Want: podRBACWant{
				ServiceAccount:      "web-sa",
				RoleBindings:        []string{},
				ClusterRoleBindings: []string{},
				Resources:           []string{},
				NonResources:        []string{},
			},
		},
		{
			Name:   "a role without rules",
			Answer: answer(emptyRole, webPodRoute),
			Want: podRBACWant{
				ServiceAccount:      "web-sa",
				RoleBindings:        []string{},
				ClusterRoleBindings: []string{"empty-crb"},
				Resources:           []string{},
				NonResources:        []string{},
			},
		},
		{
			Name:   "the cluster refused one role",
			Answer: answer(refusedRole, webPodRoute),
			Want: podRBACWant{
				ServiceAccount:      "web-sa",
				RoleBindings:        []string{"bare-subject-rb", "namespace-group-rb", "web-rb"},
				ClusterRoleBindings: []string{"account-and-everyone-crb", "all-accounts-crb", "user-crb", "web-crb"},
				Resources: []string{
					"(core)|configmaps|app-config,app-flags|get",
					"(core)|events||list",
					"(core)|nodes||get,list",
					"apps|deployments||get,list",
					"apps|deployments/scale||get,list",
					"batch|events||list",
				},
				NonResources: []string{"/healthz|get", "/metrics|get", "/openid/v1/jwks|get"},
				Incomplete:   true,
				Warnings:     1,
			},
		},
		{
			Name:   "the cluster refused one list and one role",
			Answer: answer(refusedBindings, webPodRoute),
			Want: podRBACWant{
				ServiceAccount:      "web-sa",
				RoleBindings:        []string{"bare-subject-rb", "namespace-group-rb", "web-rb"},
				ClusterRoleBindings: nil,
				Resources: []string{
					"(core)|configmaps|app-config,app-flags|get",
					"(core)|events||list",
					"apps|deployments||get,list",
					"apps|deployments/scale||get,list",
					"batch|events||list",
				},
				NonResources: []string{},
				Incomplete:   true,
				Warnings:     2,
			},
		},
		{
			Name:   "the cluster refused both lists",
			Answer: answer(refusedLists, webPodRoute),
			Want: podRBACWant{
				ServiceAccount: "web-sa",
				Resources:      []string{},
				NonResources:   []string{},
				Incomplete:     true,
				Warnings:       2,
			},
		},
	}
}

func TestPodRBACFixture(t *testing.T) {
	cases := podRBACCases(t)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	if err := enc.Encode(cases); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_POD_RBAC_CASES") == "1" {
		if err := os.WriteFile(podRBACCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(podRBACCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_POD_RBAC_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("podRbac.cases.json is not what the route answers now: rerun with UPDATE_POD_RBAC_CASES=1 and check the tab's test")
	}
}
