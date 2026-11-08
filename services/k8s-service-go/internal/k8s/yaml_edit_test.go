package k8s

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/strategicpatch"
	"k8s.io/client-go/kubernetes/scheme"
)

var (
	configMapKind  = schema.GroupVersionKind{Version: "v1", Kind: "ConfigMap"}
	deploymentKind = schema.GroupVersionKind{Group: "apps", Version: "v1", Kind: "Deployment"}
	serviceKind    = schema.GroupVersionKind{Version: "v1", Kind: "Service"}
	roleKind       = schema.GroupVersionKind{Group: "rbac.authorization.k8s.io", Version: "v1", Kind: "Role"}
	widgetKind     = schema.GroupVersionKind{Group: "example.test", Version: "v1", Kind: "Widget"}
)

func objectOf(t *testing.T, text string) map[string]interface{} {
	t.Helper()
	var out map[string]interface{}
	if err := yaml.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("parse %q: %v", text, err)
	}
	return out
}

// mergeInto is RFC 7386 as the API server applies a JSON merge patch.
func mergeInto(target, patch map[string]interface{}) {
	for key, value := range patch {
		if value == nil {
			delete(target, key)
			continue
		}
		sub, isMap := value.(map[string]interface{})
		cur, curIsMap := target[key].(map[string]interface{})
		switch {
		case isMap && curIsMap:
			mergeInto(cur, sub)
		case isMap:
			fresh := map[string]interface{}{}
			mergeInto(fresh, sub)
			target[key] = fresh
		default:
			target[key] = value
		}
	}
}

func normal(t *testing.T, object map[string]interface{}) map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// savedOver is what the API server holds after the save: `current` is the object now, which someone may have changed since
// the window's text was read. A strategic patch goes through the function the API server runs.
func savedOver(t *testing.T, gvk schema.GroupVersionKind, opened, edited, current string) (types.PatchType, map[string]interface{}) {
	t.Helper()
	patchType, patch, err := editedPatch(gvk, objectOf(t, opened), objectOf(t, edited))
	if err != nil {
		t.Fatal(err)
	}
	now := normal(t, objectOf(t, current))
	if patchType == types.StrategicMergePatchType {
		typed, err := scheme.Scheme.New(gvk)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(now)
		merged, err := strategicpatch.StrategicMergePatch(raw, patch, typed)
		if err != nil {
			t.Fatalf("apply %s: %v", patch, err)
		}
		var out map[string]interface{}
		if err := json.Unmarshal(merged, &out); err != nil {
			t.Fatal(err)
		}
		return patchType, out
	}
	var sent map[string]interface{}
	if err := json.Unmarshal(patch, &sent); err != nil {
		t.Fatal(err)
	}
	mergeInto(now, sent)
	return patchType, now
}

func wantObject(t *testing.T, got map[string]interface{}, want string) {
	t.Helper()
	wanted := normal(t, objectOf(t, want))
	if !reflect.DeepEqual(got, wanted) {
		gotText, _ := yaml.Marshal(got)
		wantText, _ := yaml.Marshal(wanted)
		t.Errorf("after the save:\n%s\nwant:\n%s", gotText, wantText)
	}
}

const configMapOpened = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app
  namespace: shop
  labels:
    team: a
    tier: b
  annotations:
    note: one
data:
  keep: "1"
  gone: "2"
`

func TestAKeyWhoseLineLeftTheWindowLeavesTheObject(t *testing.T) {
	cases := []struct {
		name, edited, want string
	}{
		{"a data key", strings.Replace(configMapOpened, "  gone: \"2\"\n", "", 1), strings.Replace(configMapOpened, "  gone: \"2\"\n", "", 1)},
		{"a label", strings.Replace(configMapOpened, "    tier: b\n", "", 1), strings.Replace(configMapOpened, "    tier: b\n", "", 1)},
		{"an annotation, whose map goes empty", strings.Replace(configMapOpened, "  annotations:\n    note: one\n", "", 1), strings.Replace(configMapOpened, "  annotations:\n    note: one\n", "", 1)},
		{"a value changed beside it", strings.Replace(strings.Replace(configMapOpened, "  gone: \"2\"\n", "", 1), "keep: \"1\"", "keep: \"9\"", 1), strings.Replace(strings.Replace(configMapOpened, "  gone: \"2\"\n", "", 1), "keep: \"1\"", "keep: \"9\"", 1)},
		{"a key left with no value", strings.Replace(configMapOpened, "gone: \"2\"", "gone:", 1), strings.Replace(configMapOpened, "  gone: \"2\"\n", "", 1)},
		{"nothing, only a comment", configMapOpened + "# a note\n", configMapOpened},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			patchType, got := savedOver(t, configMapKind, configMapOpened, c.edited, configMapOpened)
			if patchType != types.StrategicMergePatchType {
				t.Errorf("patch type %s", patchType)
			}
			wantObject(t, got, c.want)
		})
	}
}

func TestAKeySomeoneAddedSinceTheWindowOpenedStays(t *testing.T) {
	current := strings.Replace(strings.Replace(configMapOpened, "  gone: \"2\"\n", "  gone: \"2\"\n  theirs: \"3\"\n", 1), "    tier: b\n", "    tier: b\n    their-label: x\n", 1)
	edited := strings.Replace(strings.Replace(configMapOpened, "  gone: \"2\"\n", "", 1), "    tier: b\n", "", 1)
	want := strings.Replace(strings.Replace(current, "  gone: \"2\"\n", "", 1), "    tier: b\n", "", 1)
	_, got := savedOver(t, configMapKind, configMapOpened, edited, current)
	wantObject(t, got, want)
}

const deploymentOpened = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  finalizers:
  - example.test/one
  - example.test/two
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      nodeSelector:
        disk: ssd
      containers:
      - name: app
        image: app:1
        args:
        - --one
        - --two
        env:
        - name: KEEP
          value: "1"
        - name: GONE
          value: "2"
        resources:
          limits:
            cpu: 100m
            memory: 1Gi
      - name: sidecar
        image: side:1
`

func TestLinesLeftOutOfADeployment(t *testing.T) {
	cases := []struct{ name, line string }{
		{"a key deep in a list item", "            cpu: 100m\n"},
		{"an env entry, by its merge key", "        - name: GONE\n          value: \"2\"\n"},
		{"a container, by its merge key", "      - name: sidecar\n        image: side:1\n"},
		{"a whole map", "      nodeSelector:\n        disk: ssd\n"},
		{"an item of a list with no merge key", "        - --two\n"},
		{"a finalizer, a list of plain words", "  - example.test/two\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			edited := strings.Replace(deploymentOpened, c.line, "", 1)
			patchType, got := savedOver(t, deploymentKind, deploymentOpened, edited, deploymentOpened)
			if patchType != types.StrategicMergePatchType {
				t.Errorf("patch type %s", patchType)
			}
			wantObject(t, got, edited)
		})
	}
}

func TestAListItemSomeoneAddedSinceStaysWhereTheListHasAMergeKey(t *testing.T) {
	current := strings.Replace(deploymentOpened, "        - name: GONE\n", "        - name: THEIRS\n          value: \"3\"\n        - name: GONE\n", 1)
	edited := strings.Replace(deploymentOpened, "        - name: GONE\n          value: \"2\"\n", "", 1)
	_, got := savedOver(t, deploymentKind, deploymentOpened, edited, current)
	wantObject(t, got, strings.Replace(current, "        - name: GONE\n          value: \"2\"\n", "", 1))
}

func TestOtherKindsTheirListsAsTheirPatchReadsThem(t *testing.T) {
	service := "apiVersion: v1\nkind: Service\nmetadata:\n  name: s\nspec:\n  ports:\n  - name: a\n    port: 80\n  - name: b\n    port: 81\n  selector:\n    app: x\n    gone: y\n"
	edited := strings.Replace(strings.Replace(service, "  - name: b\n    port: 81\n", "", 1), "    gone: y\n", "", 1)
	_, got := savedOver(t, serviceKind, service, edited, service)
	wantObject(t, got, edited)

	role := "apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: r\nrules:\n- apiGroups: [\"\"]\n  resources: [pods]\n  verbs: [get]\n- apiGroups: [\"\"]\n  resources: [secrets]\n  verbs: [get]\n"
	edited = strings.Replace(role, "- apiGroups: [\"\"]\n  resources: [secrets]\n  verbs: [get]\n", "", 1)
	_, got = savedOver(t, roleKind, role, edited, role)
	wantObject(t, got, edited)
}

// Kubernetes itself lets a Service have one port for TCP and UDP, whose merge key `port` then names two items: a strategic
// patch cannot say which one left.
func TestAListWhoseMergeKeyNamesTwoItemsStillComesOutAsEdited(t *testing.T) {
	service := "apiVersion: v1\nkind: Service\nmetadata:\n  name: dns\nspec:\n  ports:\n  - name: tcp\n    port: 53\n    protocol: TCP\n  - name: udp\n    port: 53\n    protocol: UDP\n"
	for name, edited := range map[string]string{
		"the second leaves": strings.Replace(service, "  - name: udp\n    port: 53\n    protocol: UDP\n", "", 1),
		"the first leaves":  strings.Replace(service, "  - name: tcp\n    port: 53\n    protocol: TCP\n", "", 1),
		"one is changed":    strings.Replace(service, "name: udp", "name: dns-udp", 1),
		"a third comes":     service + "  - name: other\n    port: 54\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, got := savedOver(t, serviceKind, service, edited, service)
			wantObject(t, got, edited)
		})
	}
	deployment := "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d\nspec:\n  template:\n    spec:\n      containers:\n      - name: a\n        env:\n        - name: X\n          value: \"1\"\n        - name: X\n          value: \"2\"\n"
	t.Run("an env name given twice", func(t *testing.T) {
		edited := strings.Replace(deployment, "        - name: X\n          value: \"2\"\n", "", 1)
		_, got := savedOver(t, deploymentKind, deployment, edited, deployment)
		wantObject(t, got, edited)
	})
}

func TestAKeyWithNoValueDoesNotCostTheStrategicPatch(t *testing.T) {
	opened := strings.Replace(deploymentOpened, "            memory: 1Gi\n", "            memory: 1Gi\n", 1)
	edited := strings.Replace(opened, "            cpu: 100m\n", "            cpu:\n", 1)
	patchType, got := savedOver(t, deploymentKind, opened, edited, opened)
	if patchType != types.StrategicMergePatchType {
		t.Errorf("patch type %s", patchType)
	}
	wantObject(t, got, strings.Replace(opened, "            cpu: 100m\n", "", 1))
}

const widgetOpened = `apiVersion: example.test/v1
kind: Widget
metadata:
  name: w
  namespace: shop
  labels:
    gone: x
    keep: y
spec:
  size: 3
  deep:
    gone: 1
    keep: 2
  items:
  - a
  - b
`

// A custom resource takes no strategic patch: the API server answers 415 (apiextensions customresource_handler.go).
func TestACustomResourceGetsAJSONMergePatch(t *testing.T) {
	t.Run("keys and a list", func(t *testing.T) {
		edited := strings.NewReplacer("    gone: x\n", "", "    gone: 1\n", "", "  - b\n", "").Replace(widgetOpened)
		patchType, got := savedOver(t, widgetKind, widgetOpened, edited, widgetOpened)
		if patchType != types.MergePatchType {
			t.Errorf("patch type %s, want a JSON merge patch", patchType)
		}
		wantObject(t, got, edited)
	})
	t.Run("a key someone added since stays", func(t *testing.T) {
		current := strings.Replace(widgetOpened, "  size: 3\n", "  size: 3\n  theirs: z\n", 1)
		edited := strings.Replace(widgetOpened, "    gone: 1\n", "", 1)
		_, got := savedOver(t, widgetKind, widgetOpened, edited, current)
		wantObject(t, got, strings.Replace(current, "    gone: 1\n", "", 1))
	})
	t.Run("a list not changed is not sent, so what someone put in it since stays", func(t *testing.T) {
		current := strings.Replace(widgetOpened, "  - b\n", "  - b\n  - theirs\n", 1)
		edited := strings.Replace(widgetOpened, "    gone: 1\n", "", 1)
		_, got := savedOver(t, widgetKind, widgetOpened, edited, current)
		wantObject(t, got, strings.Replace(current, "    gone: 1\n", "", 1))
	})
}

const stampedOpened = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app
  namespace: shop
  uid: abc
  resourceVersion: "7"
  generation: 2
  creationTimestamp: "2026-01-01T00:00:00Z"
  labels:
    team: a
data:
  keep: "1"
status:
  note: x
`

func patchOf(t *testing.T, gvk schema.GroupVersionKind, opened, edited string) map[string]interface{} {
	t.Helper()
	_, raw, err := editedPatch(gvk, objectOf(t, opened), objectOf(t, edited))
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// The version the window read goes along: a save over an object changed since is refused with a 409, as it always was.
func TestASaveCarriesTheVersionItWasBasedOn(t *testing.T) {
	patch := patchOf(t, configMapKind, stampedOpened, strings.Replace(stampedOpened, "    team: a\n", "", 1))
	meta, _ := patch["metadata"].(map[string]interface{})
	if meta["resourceVersion"] != "7" {
		t.Errorf("metadata = %v, want the resourceVersion", meta)
	}
	if meta["uid"] != nil || patch["status"] != nil || patch["apiVersion"] != nil || patch["data"] != nil {
		t.Errorf("the patch names what did not change: %v", patch)
	}
}

func TestLinesAWindowCannotTakeOutStay(t *testing.T) {
	t.Run("what the object is", func(t *testing.T) {
		edited := strings.NewReplacer("apiVersion: v1\n", "", "kind: ConfigMap\n", "", "  name: app\n", "", "  namespace: shop\n", "").Replace(stampedOpened)
		patch := patchOf(t, configMapKind, stampedOpened, edited)
		if _, named := patch["apiVersion"]; named {
			t.Errorf("apiVersion in the patch: %v", patch)
		}
		if _, named := patch["kind"]; named {
			t.Errorf("kind in the patch: %v", patch)
		}
		meta, _ := patch["metadata"].(map[string]interface{})
		for _, key := range []string{"name", "namespace"} {
			if _, named := meta[key]; named {
				t.Errorf("%s in the patch: %v", key, meta)
			}
		}
	})
	t.Run("what the API server keeps", func(t *testing.T) {
		edited := strings.NewReplacer("  uid: abc\n", "", "  resourceVersion: \"7\"\n", "", "  generation: 2\n", "", "  creationTimestamp: \"2026-01-01T00:00:00Z\"\n", "").Replace(stampedOpened)
		patch := patchOf(t, configMapKind, stampedOpened, edited)
		if _, named := patch["metadata"]; named {
			t.Errorf("metadata in the patch: %v", patch)
		}
	})
	t.Run("the whole metadata block leaves its labels and nothing else", func(t *testing.T) {
		edited := "apiVersion: v1\nkind: ConfigMap\ndata:\n  keep: \"1\"\nstatus:\n  note: x\n"
		patch := patchOf(t, configMapKind, stampedOpened, edited)
		meta, _ := patch["metadata"].(map[string]interface{})
		if len(meta) != 1 {
			t.Errorf("metadata = %v, want only the labels gone", meta)
		}
		if value, named := meta["labels"]; !named || value != nil {
			t.Errorf("metadata = %v, want labels null", meta)
		}
	})
}

func TestAFieldThisClientDoesNotKnowIsStillSaved(t *testing.T) {
	opened := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\nnewField:\n  a: 1\n  b: 2\n"
	edited := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\nnewField:\n  a: 1\n"
	patchType, got := savedOver(t, configMapKind, opened, edited, opened)
	if patchType != types.MergePatchType {
		t.Errorf("patch type %s, want the JSON merge patch that needs no schema", patchType)
	}
	wantObject(t, got, edited)
}

func TestTheOpenedTextIsReadOnlyWhenItCanBe(t *testing.T) {
	cases := []struct {
		name, opened string
		object       bool
	}{
		{"none", "", false},
		{"not YAML", "a: [", false},
		{"not an object", "- a\n- b\n", false},
		{"an object", "a: 1\n", true},
	}
	for _, c := range cases {
		if got := openedObject(c.opened); (got != nil) != c.object {
			t.Errorf("%s: %v", c.name, got)
		}
	}
}
