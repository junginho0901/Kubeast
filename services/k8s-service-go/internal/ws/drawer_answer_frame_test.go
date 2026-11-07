package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// An open drawer writes what a live update says over the describe answer it shows until it reads the answer again
// (useDrawerFollowsObject). These cases take one object through the real describe and the real live update;
// useDrawerFollowsObject.test.ts runs the drawer's own function over what they gave. UPDATE_DRAWER_ANSWER_CASES=1 writes
// the file; otherwise the test fails when the file is not what the code gives now.
const drawerAnswerCasesFile = "../../../../frontend/src/components/resource-detail/drawerAnswer.cases.json"

// The kinds whose drawer follows its object.
var followedResources = map[string]bool{
	"deployments": true, "statefulsets": true, "daemonsets": true, "replicasets": true, "jobs": true, "cronjobs": true,
	"horizontalpodautoscalers": true, "clusterroles": true, "clusterrolebindings": true, "rolebindings": true,
	"priorityclasses": true, "runtimeclasses": true, "validatingwebhookconfigurations": true,
	"mutatingwebhookconfigurations": true, "limitranges": true, "resourcequotas": true, "poddisruptionbudgets": true,
	"customresourcedefinitions": true,
}

// oneObjectAPI answers a read of its object by name and every list with nothing, as a describe reads the object beside
// its events and pods.
type oneObjectAPI struct {
	mu     sync.Mutex
	object string
	svc    *k8s.Service
}

func objectName(t *testing.T, object string) string {
	t.Helper()
	var meta struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(object), &meta); err != nil {
		t.Fatal(err)
	}
	return meta.Metadata.Name
}

func newOneObjectAPI(t *testing.T) *oneObjectAPI {
	t.Helper()
	a := &oneObjectAPI{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/"+objectName(t, a.object)) {
			fmt.Fprint(w, a.object)
			return
		}
		fmt.Fprint(w, `{"metadata":{},"items":[]}`)
	}))
	t.Cleanup(server.Close)
	kubeconfig := `apiVersion: v1
kind: Config
clusters: [{name: t, cluster: {server: "` + server.URL + `"}}]
contexts: [{name: t, context: {cluster: t, user: t}}]
current-context: t
users: [{name: t, user: {token: not-a-real-token}}]
`
	reg := oneClusterRegistry{cluster.Info{ID: "t", Mode: cluster.ModeExternal, KubeconfigBlob: kubeconfig}}
	svc, err := k8s.NewService(context.Background(), reg, false, nil, k8s.ServiceOptions{MaxClusters: 2})
	if err != nil {
		t.Fatal(err)
	}
	a.svc = svc
	return a
}

func (a *oneObjectAPI) answer(t *testing.T, resource, object string) map[string]interface{} {
	t.Helper()
	a.mu.Lock()
	a.object = object
	a.mu.Unlock()
	ctx, name := context.Background(), objectName(t, object)
	var out map[string]interface{}
	var err error
	switch resource {
	case "deployments":
		out, err = a.svc.DescribeDeployment(ctx, "demo", name)
	case "statefulsets":
		out, err = a.svc.DescribeStatefulSet(ctx, "demo", name)
	case "daemonsets":
		out, err = a.svc.DescribeDaemonSet(ctx, "demo", name)
	case "replicasets":
		out, err = a.svc.DescribeReplicaSet(ctx, "demo", name)
	case "jobs":
		out, err = a.svc.DescribeJob(ctx, "demo", name)
	case "cronjobs":
		out, err = a.svc.DescribeCronJob(ctx, "demo", name)
	case "horizontalpodautoscalers":
		out, err = a.svc.DescribeHPA(ctx, "demo", name)
	case "clusterroles":
		out, err = a.svc.DescribeClusterRole(ctx, name)
	case "clusterrolebindings":
		out, err = a.svc.DescribeClusterRoleBinding(ctx, name)
	case "rolebindings":
		out, err = a.svc.DescribeRoleBinding(ctx, "demo", name)
	case "priorityclasses":
		out, err = a.svc.DescribePriorityClass(ctx, name)
	case "runtimeclasses":
		out, err = a.svc.DescribeRuntimeClass(ctx, name)
	case "validatingwebhookconfigurations":
		out, err = a.svc.DescribeValidatingWebhookConfiguration(ctx, name)
	case "mutatingwebhookconfigurations":
		out, err = a.svc.DescribeMutatingWebhookConfiguration(ctx, name)
	case "limitranges":
		out, err = a.svc.DescribeLimitRange(ctx, "demo", name)
	case "resourcequotas":
		out, err = a.svc.DescribeResourceQuota(ctx, "demo", name)
	case "poddisruptionbudgets":
		out, err = a.svc.DescribePDB(ctx, "demo", name)
	case "customresourcedefinitions":
		out, err = a.svc.DescribeCRD(ctx, name)
	default:
		t.Fatalf("no describe for %s", resource)
	}
	if err != nil {
		t.Fatalf("describe %s: %v", resource, err)
	}
	return asJSONRow(t, out)
}

// A live update takes the place of what the answer holds under the same name, so the two have to mean the same thing.
// The one exception, which the drawer leaves alone: a Job with no completions, where the row says 1 and the answer null.
func TestAnAnswerAndALiveUpdateOfOneObjectSayTheSameUnderOneName(t *testing.T) {
	api := newOneObjectAPI(t)
	seen := map[string]bool{}
	kinds := map[string]bool{}
	for _, c := range watchRowSources() {
		if !followedResources[c.resource] {
			continue
		}
		kinds[c.resource] = true
		for _, object := range []string{c.before, c.after} {
			if seen[object] {
				continue
			}
			seen[object] = true
			frame, answer := liveRow(t, c.resource, object), api.answer(t, c.resource, object)
			for key, value := range frame {
				held, ok := answer[key]
				if !ok || (c.resource == "jobs" && key == "completions" && held == nil) {
					continue
				}
				if !reflect.DeepEqual(value, held) {
					t.Errorf("%s (%s) %q: live %v, answer %v", c.name, c.resource, key, value, held)
				}
			}
		}
	}
	for resource := range followedResources {
		if !kinds[resource] {
			t.Errorf("no case holds %s", resource)
		}
	}
}

type drawerAnswerCase struct {
	Name     string                 `json:"name"`
	Resource string                 `json:"resource"`
	Before   map[string]interface{} `json:"before"`
	Frame    map[string]interface{} `json:"frame"`
	After    map[string]interface{} `json:"after"`
}

func TestDrawerAnswerCasesFixture(t *testing.T) {
	const perKind = 2
	api := newOneObjectAPI(t)
	count := map[string]int{}
	cases := []drawerAnswerCase{}
	for _, c := range watchRowSources() {
		if !followedResources[c.resource] || c.before == c.after || count[c.resource] == perKind {
			continue
		}
		count[c.resource]++
		cases = append(cases, drawerAnswerCase{
			Name:     c.name,
			Resource: c.resource,
			Before:   api.answer(t, c.resource, c.before),
			Frame:    liveRow(t, c.resource, c.after),
			After:    api.answer(t, c.resource, c.after),
		})
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(cases); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_DRAWER_ANSWER_CASES") == "1" {
		if err := os.WriteFile(drawerAnswerCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(drawerAnswerCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_DRAWER_ANSWER_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("drawerAnswer.cases.json is not what describe and the live update give now: rerun with UPDATE_DRAWER_ANSWER_CASES=1 and check the drawer's test")
	}
}
