package ws

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

const frontendSources = "../../../../frontend/src"

var (
	watchCall = regexp.MustCompile(`use(KubeWatchList|DrawerFollowsObject)\(\{`)
	apiPath   = regexp.MustCompile("['`\"](/apis?/[^'`\"]+)['`\"]")
)

// watchedResources reads the resource of every path a page hands to a watch: the quoted paths in the call, the last
// part of each. One whose last part is worked out at run time is left out.
func watchedResources(t *testing.T) map[string][]string {
	t.Helper()
	found := map[string][]string{}
	err := filepath.WalkDir(frontendSources, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || strings.Contains(path, ".test.") || !(strings.HasSuffix(path, ".ts") || strings.HasSuffix(path, ".tsx")) {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		source := string(raw)
		for _, call := range watchCall.FindAllStringIndex(source, -1) {
			body := source[call[1]:]
			if end := strings.Index(body, "\n  })"); end >= 0 {
				body = body[:end]
			}
			for _, match := range apiPath.FindAllStringSubmatch(body, -1) {
				resource := match[1][strings.LastIndex(match[1], "/")+1:]
				if !strings.Contains(resource, "$") {
					found[resource] = append(found[resource], strings.TrimPrefix(path, frontendSources+"/"))
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

// A page whose watch the server does not serve shows what it read when it opened, and nothing says so.
func TestEveryWatchAPageOpensIsServed(t *testing.T) {
	found := watchedResources(t)
	if len(found) < 30 {
		t.Fatalf("read %d resources from the pages' watches, too few to trust the search", len(found))
	}
	unserved := []string{}
	for resource, files := range found {
		if _, ok := resourceToGVR(resource); !ok {
			unserved = append(unserved, fmt.Sprintf("%s (%s)", resource, strings.Join(files, ", ")))
		}
	}
	sort.Strings(unserved)
	if len(unserved) > 0 {
		t.Errorf("%d watched resources the server answers with \"unsupported resource\":\n%s", len(unserved), strings.Join(unserved, "\n"))
	}
}

// watchEvent is object as an API server sends it to a watch.
func watchEvent(t *testing.T, object string) string {
	t.Helper()
	var compact map[string]interface{}
	if err := json.Unmarshal([]byte(object), &compact); err != nil {
		t.Fatal(err)
	}
	line, err := json.Marshal(map[string]interface{}{"type": "ADDED", "object": compact})
	if err != nil {
		t.Fatal(err)
	}
	return string(line)
}

// apiSeen is a stand-in API server that names what it was asked and answers each watch with one event.
type apiSeen struct {
	mu     sync.Mutex
	object string
	paths  []string
	status int
}

func (a *apiSeen) serve(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	a.paths = append(a.paths, r.URL.Path)
	object, status := a.object, a.status
	a.mu.Unlock()
	if status != 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprintf(w, `{"apiVersion":"v1","kind":"Status","status":"Failure","code":%d,"message":"the server could not find the requested resource"}`, status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintln(w, object)
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

func (a *apiSeen) asked() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.paths...)
}

func (a *apiSeen) reset(object string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.object, a.paths = object, nil
}

// socketAs opens a tab's socket on m as this caller.
func socketAs(t *testing.T, m *Multiplexer, payload auth.TokenPayload) *websocket.Conn {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.HandleWebSocket(w, r.WithContext(auth.WithPayload(r.Context(), payload)))
	}))
	t.Cleanup(server.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))
	return conn
}

// The paths the list screens and the drawers open, the API path each has to reach, and the row the list API gives for
// the same object: the watch carries that row. RoleBindings are asked for under /api/v1 by their list page and under
// their own group by the drawers.
func TestEachListsWatchReachesItsKindAndSendsTheListRow(t *testing.T) {
	const rbac = "/apis/rbac.authorization.k8s.io/v1"
	for _, c := range []struct {
		path, reaches, resource, object string
	}{
		{rbac + "/clusterroles", rbac + "/clusterroles", "clusterroles", crFull},
		{rbac + "/clusterrolebindings", rbac + "/clusterrolebindings", "clusterrolebindings", crbFull},
		{"/api/v1/rolebindings", rbac + "/rolebindings", "rolebindings", rbFull},
		{"/api/v1/namespaces/demo/rolebindings", rbac + "/namespaces/demo/rolebindings", "rolebindings", rbFull},
		{rbac + "/rolebindings", rbac + "/rolebindings", "rolebindings", rbFull},
		{rbac + "/namespaces/demo/rolebindings", rbac + "/namespaces/demo/rolebindings", "rolebindings", rbFull},
		{"/apis/scheduling.k8s.io/v1/priorityclasses", "/apis/scheduling.k8s.io/v1/priorityclasses", "priorityclasses", pcFull},
		{"/apis/node.k8s.io/v1/runtimeclasses", "/apis/node.k8s.io/v1/runtimeclasses", "runtimeclasses", rcFull},
		{"/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations", "/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations", "validatingwebhookconfigurations", vwcFull},
		{"/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations", "/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations", "mutatingwebhookconfigurations", mwcFull},
		{"/apis/coordination.k8s.io/v1/leases", "/apis/coordination.k8s.io/v1/leases", "leases", leaseHeld},
		{"/apis/coordination.k8s.io/v1/namespaces/demo/leases", "/apis/coordination.k8s.io/v1/namespaces/demo/leases", "leases", leaseHeld},
		{"/api/v1/limitranges", "/api/v1/limitranges", "limitranges", lrFull},
		{"/api/v1/namespaces/demo/limitranges", "/api/v1/namespaces/demo/limitranges", "limitranges", lrFull},
		{"/api/v1/resourcequotas", "/api/v1/resourcequotas", "resourcequotas", rqFull},
		{"/api/v1/namespaces/demo/resourcequotas", "/api/v1/namespaces/demo/resourcequotas", "resourcequotas", rqFull},
		{"/apis/policy/v1/poddisruptionbudgets", "/apis/policy/v1/poddisruptionbudgets", "poddisruptionbudgets", pdbMin},
		{"/apis/policy/v1/namespaces/demo/poddisruptionbudgets", "/apis/policy/v1/namespaces/demo/poddisruptionbudgets", "poddisruptionbudgets", pdbMin},
		{"/apis/apiextensions.k8s.io/v1/customresourcedefinitions", "/apis/apiextensions.k8s.io/v1/customresourcedefinitions", "customresourcedefinitions", crdTwo},
	} {
		t.Run(c.path, func(t *testing.T) {
			api := &apiSeen{object: watchEvent(t, c.object)}
			m := muxOn(t, api.serve)
			conn := socketTo(t, m, everyCluster)
			request(t, conn, "REQUEST", "default", c.path, "watch=1")
			f := nextFrame(t, conn)
			if f.Type != "DATA" {
				t.Fatalf("frame %s: %s", f.Type, f.Error.Message)
			}
			if asked := api.asked(); len(asked) != 1 || asked[0] != c.reaches {
				t.Errorf("the API server was asked for %v, want %s", asked, c.reaches)
			}
			want := newListAPI(t).row(t, c.resource, c.object)
			if !reflect.DeepEqual(f.Data.Object, map[string]any(want)) {
				t.Errorf("the frame is not the list's row:\n frame %v\n list  %v", f.Data.Object, want)
			}
		})
	}
}

var scopedToTeamA = auth.TokenPayload{
	Perms:      auth.PermissionMatrix{"self": {"resource.*.read"}},
	Namespaces: map[string][]string{"self": {"team-a"}},
}

// A kind of the cluster has no namespace to watch it in. The page of a grant limited to namespaces still asks once per
// namespace (scopedPaths): the answer says no once, keeps no place in the tab's limit and asks the cluster nothing.
func TestAWatchOfAClusterScopedKindIsRefusedOnceToAGrantLimitedToNamespaces(t *testing.T) {
	for _, resource := range []string{
		"/apis/rbac.authorization.k8s.io/v1/namespaces/team-a/clusterroles",
		"/apis/rbac.authorization.k8s.io/v1/namespaces/team-a/clusterrolebindings",
		"/apis/scheduling.k8s.io/v1/namespaces/team-a/priorityclasses",
		"/apis/node.k8s.io/v1/namespaces/team-a/runtimeclasses",
		"/apis/admissionregistration.k8s.io/v1/namespaces/team-a/validatingwebhookconfigurations",
		"/apis/admissionregistration.k8s.io/v1/namespaces/team-a/mutatingwebhookconfigurations",
		"/apis/apiextensions.k8s.io/v1/namespaces/team-a/customresourcedefinitions",
		"/api/v1/namespaces/team-a/nodes",
		"/api/v1/namespaces/team-a/namespaces",
		"/api/v1/namespaces/team-a/pvs",
		"/api/v1/namespaces/team-a/persistentvolumes",
		"/api/v1/namespaces/team-a/storageclasses",
		"/api/v1/namespaces/team-a/ingressclasses",
		"/api/v1/namespaces/team-a/volumeattachments",
		"/api/v1/namespaces/team-a/gatewayclasses",
		"/api/v1/namespaces/team-a/deviceclasses",
		"/api/v1/namespaces/team-a/resourceslices",
	} {
		t.Run(resource, func(t *testing.T) {
			api := &apiSeen{status: http.StatusNotFound}
			m := muxOn(t, api.serve)
			conn := socketAs(t, m, scopedToTeamA)
			request(t, conn, "REQUEST", "self", resource, "watch=1")
			f := nextFrame(t, conn)
			if f.Type != "ERROR" || !strings.Contains(f.Error.Message, "of the cluster") {
				t.Fatalf("frame %s %q, want a refusal naming the kind as the cluster's", f.Type, f.Error.Message)
			}
			if f.Error.Reason != "scope" {
				t.Errorf("reason %q, want scope", f.Error.Reason)
			}
			waitForSubscriptions(t, m, 0)
			if asked := api.asked(); len(asked) != 0 {
				t.Errorf("the API server was asked for %v", asked)
			}
		})
	}
}

// The kinds a namespace holds. Whatever else a watch can reach has no namespace, so a new kind is decided here.
var namespacedWatchKinds = map[string]bool{
	"pods": true, "services": true, "events": true, "persistentvolumeclaims": true, "pvcs": true, "configmaps": true,
	"secrets": true, "endpoints": true, "deployments": true, "statefulsets": true, "daemonsets": true, "replicasets": true,
	"ingresses": true, "networkpolicies": true, "endpointslices": true, "jobs": true, "cronjobs": true, "gateways": true,
	"httproutes": true, "grpcroutes": true, "referencegrants": true, "backendtlspolicies": true, "serviceaccounts": true,
	"roles": true, "rolebindings": true, "horizontalpodautoscalers": true, "verticalpodautoscalers": true,
	"resourceclaims": true, "resourceclaimtemplates": true, "leases": true, "limitranges": true, "resourcequotas": true,
	"poddisruptionbudgets": true,
}

// A kind left out of clusterWideWatch asks the cluster every five seconds per namespace, and holds a place each time.
func TestEveryKindWithNoNamespaceIsRefusedToAGrantLimitedToNamespaces(t *testing.T) {
	wrong := []string{}
	for resource, gvr := range watchKinds {
		if clusterWideWatch[resource] == namespacedWatchKinds[resource] {
			wrong = append(wrong, fmt.Sprintf("%s: in clusterWideWatch %v, a namespaced kind %v", resource, clusterWideWatch[resource], namespacedWatchKinds[resource]))
		}
		if clusterWideWatch[resource] != clusterWideWatch[gvr.Resource] {
			wrong = append(wrong, fmt.Sprintf("%s answers otherwise than %s, the kind it names", resource, gvr.Resource))
		}
	}
	sort.Strings(wrong)
	if len(wrong) > 0 {
		t.Errorf("%d kinds decided wrongly:\n%s", len(wrong), strings.Join(wrong, "\n"))
	}
	for resource := range clusterWideWatch {
		if _, ok := watchKinds[resource]; !ok {
			t.Errorf("%s is in clusterWideWatch and no watch reaches it", resource)
		}
	}
}

// The refusal stays with the grant: a caller with no limit on namespaces reaches the same kinds through the cluster's own RBAC.
func TestAClusterScopedKindStaysOpenToAGrantWithNoLimitOnNamespaces(t *testing.T) {
	for _, path := range []string{"/api/v1/nodes", "/api/v1/namespaces", "/api/v1/pvs", "/api/v1/storageclasses", "/api/v1/ingressclasses"} {
		if reason := namespaceScopeRefusal(auth.TokenPayload{Perms: auth.PermissionMatrix{"self": {"resource.*.read"}}}, "self", path); reason != "" {
			t.Errorf("%s was refused: %s", path, reason)
		}
	}
}

// The grant's own namespace reaches the cluster as the user; the others do not, whichever kind.
func TestAWatchOfANamespacedKindStaysInTheGrantsNamespaces(t *testing.T) {
	for _, c := range []struct{ allowed, refused, object string }{
		{"/api/v1/namespaces/team-a/rolebindings", "/api/v1/namespaces/team-b/rolebindings", rbFull},
		{"/apis/rbac.authorization.k8s.io/v1/namespaces/team-a/rolebindings", "/apis/rbac.authorization.k8s.io/v1/namespaces/team-b/rolebindings", rbFull},
		{"/apis/coordination.k8s.io/v1/namespaces/team-a/leases", "/apis/coordination.k8s.io/v1/namespaces/team-b/leases", leaseHeld},
		{"/api/v1/namespaces/team-a/limitranges", "/api/v1/namespaces/team-b/limitranges", lrFull},
		{"/api/v1/namespaces/team-a/resourcequotas", "/api/v1/namespaces/team-b/resourcequotas", rqFull},
		{"/apis/policy/v1/namespaces/team-a/poddisruptionbudgets", "/apis/policy/v1/namespaces/team-b/poddisruptionbudgets", pdbMin},
	} {
		t.Run(c.allowed, func(t *testing.T) {
			api := &apiSeen{object: watchEvent(t, c.object)}
			m := muxOn(t, api.serve)
			conn := socketAs(t, m, scopedToTeamA)

			request(t, conn, "REQUEST", "self", c.refused, "watch=1")
			if f := nextFrame(t, conn); f.Type != "ERROR" || !strings.Contains(f.Error.Message, "team-b") {
				t.Fatalf("frame %s %q, want the namespace refused", f.Type, f.Error.Message)
			}
			if asked := api.asked(); len(asked) != 0 {
				t.Errorf("the API server was asked for %v", asked)
			}

			request(t, conn, "REQUEST", "self", c.allowed, "watch=1")
			if f := nextFrame(t, conn); f.Type != "DATA" {
				t.Fatalf("frame %s %q, want the object", f.Type, f.Error.Message)
			}
		})
	}
}

// What the cluster refuses is its answer and not ours: the page's identity may not watch the kind, and it is asked again.
func TestAWatchTheClusterRefusesSaysSoAndKeepsItsPlace(t *testing.T) {
	api := &apiSeen{status: http.StatusForbidden}
	m := muxOn(t, api.serve)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "default", "/apis/coordination.k8s.io/v1/namespaces/demo/leases", "watch=1")
	if f := nextFrame(t, conn); f.Type != "ERROR" {
		t.Fatalf("frame %s, want the cluster's refusal", f.Type)
	}
	waitForSubscriptions(t, m, 1)
}

// A row counts a configuration's webhooks: their addresses and CA bundles stay in the drawer, which asks for them.
func TestALiveRowOfAWebhookConfigurationCountsItsWebhooks(t *testing.T) {
	api := newListAPI(t)
	for _, c := range []struct{ resource, object string }{
		{"validatingwebhookconfigurations", vwcFull},
		{"mutatingwebhookconfigurations", mwcFull},
	} {
		for what, row := range map[string]map[string]interface{}{"live": liveRow(t, c.resource, c.object), "list": api.row(t, c.resource, c.object)} {
			raw, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw), whCA) || strings.Contains(string(raw), "hook.example.test") {
				t.Errorf("the %s row of %s holds a webhook: %s", what, c.resource, raw)
			}
			if row["webhooks_count"] != float64(2) {
				t.Errorf("the %s row of %s counts %v", what, c.resource, row["webhooks_count"])
			}
		}
	}
}
