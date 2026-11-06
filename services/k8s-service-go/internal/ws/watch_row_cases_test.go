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
	"sync"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// A list page starts from the list API and then applies live updates, so one object has to read the same both ways.
// These cases take an object as the API server sends it through the real list code and the real live update code;
// watchRows.cases.test.ts then runs the page's own functions over what they gave. UPDATE_WATCH_ROW_CASES=1 writes the
// file; otherwise the test fails when the file is not what the code gives now.
const watchRowCasesFile = "../../../../frontend/src/services/watchRows.cases.json"

const (
	ingressWeb = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z","labels":{"team":"a"},"annotations":{"note":"kept"}},
		"spec":{"ingressClassName":"nginx","tls":[{"hosts":["example.test"],"secretName":"web-tls"}],
		"rules":[{"host":"example.test","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"web","port":{"number":80}}}}]}}]},
		"status":{"loadBalancer":{"ingress":[{"ip":"192.0.2.1"}]}}}`
	ingressDefaultBackendOnly = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},
		"spec":{"defaultBackend":{"service":{"name":"fallback","port":{"number":80}}}},"status":{}}`
	ingressAnnotatedClass = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z","annotations":{"kubernetes.io/ingress.class":"nginx"}},
		"spec":{"rules":[{"host":"example.test"}]},"status":{}}`
	ingressNoClass = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},
		"spec":{"rules":[{"host":"example.test"}]},"status":{}}`
	ingressEmpty = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},"spec":{},"status":{}}`
	ingressFull  = `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"web","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},
		"spec":{"ingressClassName":"traefik","tls":[{"secretName":"no-hosts"}],
		"rules":[{"host":"b.example.test","http":{"paths":[{"path":"/b","pathType":"Exact","backend":{"service":{"name":"zeta","port":{"name":"http"}}}}]}},
		{"host":"a.example.test","http":{"paths":[{"path":"/a","pathType":"Prefix","backend":{"service":{"name":"alpha","port":{"number":8080}}}}]}}]},
		"status":{"loadBalancer":{"ingress":[{"hostname":"lb.example.test","ports":[{"port":443,"protocol":"TCP"}]}]}}}`

	vaSpec   = `"spec":{"attacher":"csi.example.test","nodeName":"node-a","source":{"persistentVolumeName":"pv-a"}}`
	vaMeta   = `{"apiVersion":"storage.k8s.io/v1","kind":"VolumeAttachment","metadata":{"name":"disk-a","creationTimestamp":"2026-11-01T00:00:00Z"},`
	vaFailed = vaMeta + vaSpec + `,"status":{"attached":false,"attachError":{"time":"2026-11-05T00:00:00Z","message":"attach failed"}}}`
	vaOK     = vaMeta + vaSpec + `,"status":{"attached":true}}`
	vaDetErr = vaMeta + vaSpec + `,"status":{"attached":true,"detachError":{"time":"2026-11-05T00:00:00Z","message":"detach failed"}}}`
	vaOff    = vaMeta + vaSpec + `,"status":{"attached":false}}`
	vaNoStat = vaMeta + vaSpec + `}`

	cronMeta = `{"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"daily","namespace":"demo","creationTimestamp":"2026-11-01T00:00:00Z"},`
	cronJob  = `"jobTemplate":{"spec":{"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"app","image":"example.test/app:1"}]}}}}`
	cronOld  = cronMeta + `"spec":{"schedule":"0 9 * * *","timeZone":"Asia/Seoul","concurrencyPolicy":"Allow",` + cronJob + `},
		"status":{"active":[{"kind":"Job","name":"daily-1","namespace":"demo"}],"lastScheduleTime":"2026-11-05T00:00:00Z","lastSuccessfulTime":"2026-11-05T00:01:00Z"}}`
	cronNoZone = cronMeta + `"spec":{"schedule":"0 9 * * *","concurrencyPolicy":"Allow",` + cronJob + `},
		"status":{"lastScheduleTime":"2026-11-06T09:00:00Z","lastSuccessfulTime":"2026-11-06T09:01:00Z"}}`
	cronUTC = cronMeta + `"spec":{"schedule":"0 9 * * *","timeZone":"Etc/UTC","concurrencyPolicy":"Allow",` + cronJob + `},
		"status":{"lastScheduleTime":"2026-11-06T09:00:00Z","lastSuccessfulTime":"2026-11-06T09:01:00Z"}}`
	cronNoRuns = cronMeta + `"spec":{"schedule":"0 9 * * *","timeZone":"Asia/Seoul","concurrencyPolicy":"Allow",` + cronJob + `},"status":{}}`
	cronOther  = cronMeta + `"spec":{"schedule":"30 1 * * *","suspend":true,"concurrencyPolicy":"Forbid",
		"jobTemplate":{"spec":{"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"new","image":"example.test/new:2"},{"name":"side","image":"example.test/side:1"}]}}}}},"status":{}}`
)

type watchRowSource struct {
	name, resource, before, after string
	// what the page shows once the update is applied, written by hand so a wrong row on both sides still fails
	shows map[string]interface{}
}

func watchRowSources() []watchRowSource {
	ingressShows := func(class, hosts, backends, addresses, rules string, tls int) map[string]interface{} {
		return map[string]interface{}{"class": class, "hosts": hosts, "backends": backends, "addresses": addresses, "rules": rules, "tls": tls}
	}
	vaShows := func(attached bool, status, errorText string) map[string]interface{} {
		return map[string]interface{}{"attached": attached, "status": status, "error": errorText}
	}
	cronShows := func(schedule string, suspend bool, active int, policy, lastSchedule, lastSuccessful, zone, containers, images interface{}) map[string]interface{} {
		return map[string]interface{}{
			"schedule": schedule, "suspend": suspend, "active": active, "concurrency_policy": policy,
			"last_schedule_time": lastSchedule, "last_successful_time": lastSuccessful, "time_zone": zone,
			"containers": containers, "images": images,
		}
	}
	return []watchRowSource{
		{"an Ingress left with only its default backend shows no host, class, address or TLS", "ingresses", ingressWeb, ingressDefaultBackendOnly, ingressShows("-", "-", "-", "-", "-", 0)},
		{"an Ingress whose class annotation went away shows no class", "ingresses", ingressAnnotatedClass, ingressNoClass, ingressShows("-", "example.test", "-", "-", "example.test:/*", 0)},
		{"an Ingress that gained its rules, address and TLS shows them", "ingresses", ingressEmpty, ingressFull, ingressShows("traefik", "b.example.test, a.example.test", "alpha, zeta", "lb.example.test", "b.example.test:/b, a.example.test:/a", 1)},
		{"a VolumeAttachment that recovered is Attached with no error left", "volumeattachments", vaFailed, vaOK, vaShows(true, "Attached", "-")},
		{"a VolumeAttachment that failed to attach shows the error", "volumeattachments", vaOK, vaFailed, vaShows(false, "Error", "attach failed")},
		{"a VolumeAttachment that finished detaching is Detached with no error left", "volumeattachments", vaDetErr, vaOff, vaShows(false, "Detached", "-")},
		{"a VolumeAttachment with no status yet is not attached", "volumeattachments", vaOK, vaNoStat, vaShows(false, "Detached", "-")},
		{"a CronJob whose time zone was cleared shows none, with its new run times", "cronjobs", cronOld, cronNoZone, cronShows("0 9 * * *", false, 0, "Allow", "2026-11-06T09:00:00Z", "2026-11-06T09:01:00Z", nil, "app", "example.test/app:1")},
		{"a CronJob whose time zone changed shows the new one", "cronjobs", cronOld, cronUTC, cronShows("0 9 * * *", false, 0, "Allow", "2026-11-06T09:00:00Z", "2026-11-06T09:01:00Z", "Etc/UTC", "app", "example.test/app:1")},
		{"a CronJob whose status lost its run times shows none", "cronjobs", cronOld, cronNoRuns, cronShows("0 9 * * *", false, 0, "Allow", nil, nil, "Asia/Seoul", "app", "example.test/app:1")},
		{"a CronJob whose schedule, policy and containers changed shows the new ones", "cronjobs", cronOld, cronOther, cronShows("30 1 * * *", true, 0, "Forbid", nil, nil, nil, "new, side", "example.test/new:2, example.test/side:1")},
	}
}

// listAPI answers every list with the one object it holds, as an API server does, and hands back the row the list
// endpoint makes of it.
type listAPI struct {
	mu     sync.Mutex
	object string
	svc    *k8s.Service
}

type oneClusterRegistry struct{ info cluster.Info }

func (r oneClusterRegistry) List(context.Context) ([]cluster.Info, error) {
	return []cluster.Info{r.info}, nil
}
func (r oneClusterRegistry) Get(context.Context, cluster.ID) (*cluster.Info, error) {
	return &r.info, nil
}
func (r oneClusterRegistry) Default(context.Context) (cluster.ID, error) { return r.info.ID, nil }

func newListAPI(t *testing.T) *listAPI {
	t.Helper()
	a := &listAPI{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		var meta struct{ APIVersion, Kind string }
		if err := json.Unmarshal([]byte(a.object), &meta); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"apiVersion":%q,"kind":%q,"metadata":{},"items":[%s]}`, meta.APIVersion, meta.Kind+"List", a.object)
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

func (a *listAPI) row(t *testing.T, resource, object string) map[string]interface{} {
	t.Helper()
	a.mu.Lock()
	a.object = object
	a.mu.Unlock()
	ctx := context.Background()
	var rows []map[string]interface{}
	var err error
	switch resource {
	case "ingresses":
		rows, err = a.svc.GetIngresses(ctx, "demo")
	case "volumeattachments":
		rows, err = a.svc.GetVolumeAttachments(ctx)
	case "cronjobs":
		rows, err = a.svc.GetCronJobs(ctx, "demo")
	default:
		t.Fatalf("no list for %s", resource)
	}
	if err != nil {
		t.Fatalf("list %s: %v", resource, err)
	}
	if len(rows) != 1 {
		t.Fatalf("list %s: %d rows", resource, len(rows))
	}
	return asJSONRow(t, rows[0])
}

// asJSONRow is the row as it goes over the wire, so an int32 and an int64 of one value compare equal.
func asJSONRow(t *testing.T, row map[string]interface{}) map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func liveRow(t *testing.T, resource, object string) map[string]interface{} {
	t.Helper()
	var obj unstructured.Unstructured
	if err := obj.UnmarshalJSON([]byte(object)); err != nil {
		t.Fatal(err)
	}
	return asJSONRow(t, objectToInfo(resource, &obj))
}

// The live update of an object carries the row the list API gives for the same object, every key and value.
func TestLiveUpdateRowIsTheListRow(t *testing.T) {
	api := newListAPI(t)
	seen := map[string]bool{}
	for _, c := range watchRowSources() {
		for _, object := range []string{c.before, c.after} {
			if seen[object] {
				continue
			}
			seen[object] = true
			list, live := api.row(t, c.resource, object), liveRow(t, c.resource, object)
			if !reflect.DeepEqual(live, list) {
				listJSON, _ := json.Marshal(list)
				liveJSON, _ := json.Marshal(live)
				t.Errorf("%s (%s):\n live %s\n list %s", c.name, c.resource, liveJSON, listJSON)
			}
		}
	}
}

type watchRowCase struct {
	Name     string                 `json:"name"`
	Resource string                 `json:"resource"`
	Before   map[string]interface{} `json:"before"`
	Event    map[string]interface{} `json:"event"`
	After    map[string]interface{} `json:"after"`
	Shows    map[string]interface{} `json:"shows"`
}

func TestWatchRowCasesFixture(t *testing.T) {
	api := newListAPI(t)
	cases := []watchRowCase{}
	for _, c := range watchRowSources() {
		cases = append(cases, watchRowCase{
			Name:     c.name,
			Resource: c.resource,
			Before:   api.row(t, c.resource, c.before),
			Event:    liveRow(t, c.resource, c.after),
			After:    api.row(t, c.resource, c.after),
			Shows:    c.shows,
		})
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	if err := enc.Encode(cases); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_WATCH_ROW_CASES") == "1" {
		if err := os.WriteFile(watchRowCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(watchRowCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_WATCH_ROW_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("watchRows.cases.json is not what the list and the live update give now: rerun with UPDATE_WATCH_ROW_CASES=1 and check the page's test")
	}
}

// An object the typed conversion refuses still reaches the page: by its name, with spec and status nested as
// genericToInfo sends them, which the page's normalizers read (watchRows.cases.test.ts).
func TestLiveRowOfAnObjectThatDoesNotConvertKeepsItsNameAndNestedSpec(t *testing.T) {
	for resource, object := range map[string]string{
		"ingresses":         `{"apiVersion":"networking.k8s.io/v1","kind":"Ingress","metadata":{"name":"odd","namespace":"demo"},"spec":{"rules":"not a list"}}`,
		"volumeattachments": `{"apiVersion":"storage.k8s.io/v1","kind":"VolumeAttachment","metadata":{"name":"odd"},"spec":{"attacher":7},"status":{"attached":true}}`,
		"cronjobs":          `{"apiVersion":"batch/v1","kind":"CronJob","metadata":{"name":"odd","namespace":"demo"},"spec":{"schedule":7}}`,
	} {
		row := liveRow(t, resource, object)
		if row["name"] != "odd" || row["spec"] == nil {
			t.Errorf("%s: %v, want the name and the nested spec", resource, row)
		}
	}
}
