package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"

	utilyaml "k8s.io/apimachinery/pkg/util/yaml"

	"github.com/junginho0901/kubeast/services/pkg/redact"
)

func withYAMLSpecFirst(t *testing.T, value string) {
	t.Helper()
	t.Setenv("AI_YAML_SPEC_FIRST", value)
	was := redactOpts
	redactOpts = redact.Options{Enabled: true, Disabled: map[string]bool{}}
	t.Cleanup(func() { redactOpts = was })
}

// readYAML is k8s_get_resource_yaml's answer where kubectl prints out.
func readYAML(t *testing.T, resourceType, out string) string {
	t.Helper()
	fakeKubectl(t, func([]string) (string, error) { return out, nil })
	got, err := handleGetResourceYAML(ctxFor("c1"), args{"resource_type": resourceType, "resource_name": "indexer", "namespace": "shop"}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// indexerEnv is the variables the indexer was applied with, beside the ones the tests change.
func indexerEnv() (yaml string, applied []interface{}) {
	var b strings.Builder
	for i := 1; i <= 30; i++ {
		name, value := fmt.Sprintf("INDEX_SHARD_%02d_ROUTING", i), fmt.Sprintf("shard-%02d.indexer-headless.shop.svc.cluster.local:9300", i)
		fmt.Fprintf(&b, "        - name: %s\n          value: %s\n", name, value)
		applied = append(applied, map[string]interface{}{"name": name, "value": value})
	}
	return b.String(), applied
}

// indexerYAML is a StatefulSet as kubectl get -o yaml --show-managed-fields prints it: applied with replicas 1, envFrom
// indexes, WORKERS 3, cpu 1000m, another DB_PASSWORD, OLD_FLAG and a termination grace of 30, and changed since.
func indexerYAML(t *testing.T) string {
	t.Helper()
	envYAML, envApplied := indexerEnv()
	applied := map[string]interface{}{
		"apiVersion": "apps/v1", "kind": "StatefulSet",
		"metadata": map[string]interface{}{"annotations": map[string]interface{}{"team": "search"}, "creationTimestamp": nil, "labels": map[string]interface{}{"app": "indexer"}, "name": "indexer", "namespace": "shop"},
		"spec": map[string]interface{}{
			"replicas": 1, "serviceName": "indexer-headless", "selector": map[string]interface{}{"matchLabels": map[string]interface{}{"app": "indexer"}},
			"template": map[string]interface{}{
				"metadata": map[string]interface{}{"creationTimestamp": nil, "labels": map[string]interface{}{"app": "indexer"}},
				"spec": map[string]interface{}{
					"terminationGracePeriodSeconds": 30,
					"containers": []interface{}{map[string]interface{}{
						"name": "indexer", "image": "registry.example/indexer:4.2.0",
						"env": append(append([]interface{}{}, envApplied...),
							map[string]interface{}{"name": "WORKERS", "value": "3"},
							map[string]interface{}{"name": "DB_PASSWORD", "value": "planted-db-pass-1"},
							map[string]interface{}{"name": "OLD_FLAG", "value": "on"}),
						"envFrom":   []interface{}{map[string]interface{}{"configMapRef": map[string]interface{}{"name": "indexes"}}},
						"resources": map[string]interface{}{"limits": map[string]interface{}{"cpu": "1000m", "memory": "512Mi"}},
					}},
				},
			},
		},
		"status": map[string]interface{}{"replicas": 0},
	}
	raw, err := json.Marshal(applied)
	if err != nil {
		t.Fatal(err)
	}
	return `apiVersion: apps/v1
kind: StatefulSet
metadata:
  annotations:
    kubectl.kubernetes.io/last-applied-configuration: |
      ` + string(raw) + `
    team: search
  creationTimestamp: "2026-11-19T02:11:05Z"
  generation: 4
  labels:
    app: indexer
  managedFields:
  - apiVersion: apps/v1
    fieldsType: FieldsV1
    fieldsV1:
      f:metadata:
        f:annotations:
          .: {}
          f:kubectl.kubernetes.io/last-applied-configuration: {}
        f:labels:
          .: {}
          f:app: {}
      f:spec:
        f:replicas: {}
    manager: kubectl-client-side-apply
    operation: Update
    time: "2026-11-19T02:11:05Z"
  - apiVersion: apps/v1
    fieldsType: FieldsV1
    fieldsV1:
      f:spec:
        f:replicas: {}
    manager: kubectl-edit
    operation: Update
    time: "2026-11-20T04:20:11Z"
  name: indexer
  namespace: shop
  resourceVersion: "184220"
  uid: 7f6f1a52-3d1f-4a3e-8f36-0f4b7f5b3f10
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain
    whenScaled: Retain
  podManagementPolicy: OrderedReady
  replicas: 2
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      app: indexer
  serviceName: indexer-headless
  template:
    metadata:
      annotations:
        kubectl.kubernetes.io/restartedAt: "2026-11-20T04:20:30Z"
      labels:
        app: indexer
    spec:
      containers:
      - env:
` + envYAML + `        - name: WORKERS
          value: "6"
        - name: DB_PASSWORD
          value: planted-db-pass-2
        envFrom:
        - configMapRef:
            name: indexes-2
        image: registry.example/indexer:4.2.0
        imagePullPolicy: IfNotPresent
        name: indexer
        resources:
          limits:
            cpu: "1"
            memory: 512Mi
        terminationMessagePath: /dev/termination-log
        terminationMessagePolicy: File
      dnsPolicy: ClusterFirst
      restartPolicy: Always
      schedulerName: default-scheduler
      securityContext: {}
      terminationGracePeriodSeconds: 30
  updateStrategy:
    rollingUpdate:
      partition: 0
    type: RollingUpdate
status:
  availableReplicas: 1
  collisionCount: 0
  currentReplicas: 1
  currentRevision: indexer-6d8f9c7b5d
  observedGeneration: 4
  readyReplicas: 1
  replicas: 2
  updateRevision: indexer-7c9b5f4d8f
`
}

const indexerDiffers = "# differs from last-applied: spec.replicas: 1 → 2" +
	"; spec.template.spec.containers[indexer].env[WORKERS].value: \"3\" → \"6\"" +
	"; spec.template.spec.containers[indexer].env[DB_PASSWORD].value (changed, value masked)" +
	"; spec.template.spec.containers[indexer].env[OLD_FLAG]: {\"name\":\"OLD_FLAG\",\"value\":\"on\"} → (absent)" +
	"; spec.template.spec.containers[indexer].envFrom[0].configMapRef.name: \"indexes\" → \"indexes-2\"" +
	"; spec.template.metadata.annotations[\"kubectl.kubernetes.io/restartedAt\"]: (absent) → \"2026-11-20T04:20:30Z\""

func TestYAMLSpecFirst_OffTheAnswerIsKubectlsText(t *testing.T) {
	out := indexerYAML(t)
	for _, value := range []string{"", "false", "0", "off"} {
		withYAMLSpecFirst(t, value)
		t.Setenv("AI_TRACE_SPAN_TABLE", "true") // the other switch does nothing here
		if got := readYAML(t, "statefulset", out); got != out {
			t.Errorf("switch %q: the answer changed:\n%s", value, got)
		}
	}
	// what the model reads of it: the annotation's older values, and not the spec
	if at := strings.Index(out, "\nspec:\n"); at < 4000 {
		t.Errorf("the spec starts at %d", at)
	}
}

func yamlObject(t *testing.T, text string) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := utilyaml.Unmarshal([]byte(text), &m); err != nil {
		t.Fatalf("not YAML: %v\n%s", err, text)
	}
	return m
}

func TestYAMLSpecFirst_TheSpecFirstAndWhatDiffersLast(t *testing.T) {
	withYAMLSpecFirst(t, "true")
	out := indexerYAML(t)
	got := readYAML(t, "statefulset", out)
	t.Logf("%d characters as kubectl prints it, the spec at %d and %d of them in the first %d; %d with the spec first, the spec at %d",
		utf8.RuneCountInString(out), strings.Index(out, "\nspec:\n"), max(0, modelResultChars-strings.Index(out, "\nspec:\n")), modelResultChars, utf8.RuneCountInString(got), strings.Index(got, "\nspec:\n"))
	if !strings.HasPrefix(got, "apiVersion: apps/v1\nkind: StatefulSet\nspec:\n  persistentVolumeClaimRetentionPolicy:\n") {
		t.Errorf("starts with %q", got[:120])
	}
	order := []string{"\nspec:\n", "\nmetadata:\n", "\nstatus:\n", "\n# differs from last-applied: "}
	for i := 1; i < len(order); i++ {
		if a, b := strings.Index(got, order[i-1]), strings.Index(got, order[i]); a < 0 || b < a {
			t.Errorf("%q at %d, %q at %d", order[i-1], a, order[i], b)
		}
	}
	for _, gone := range []string{"managedFields", "last-applied-configuration: |", "f:spec", "kubectl-client-side-apply"} {
		if strings.Contains(got, gone) {
			t.Errorf("%q is still there", gone)
		}
	}
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
	if last := lines[len(lines)-1]; last != indexerDiffers {
		t.Errorf("last line\n got %s\nwant %s", last, indexerDiffers)
	}
	// the object is the same but for the two that went
	want := yamlObject(t, out)
	metadata := want["metadata"].(map[string]interface{})
	delete(metadata, "managedFields")
	delete(metadata["annotations"].(map[string]interface{}), lastAppliedAnnotation)
	if left := yamlObject(t, got); !reflect.DeepEqual(left, want) {
		t.Errorf("the object is another:\n%v\n%v", left, want)
	}
	// and every other line is kubectl's own
	had := map[string]int{}
	for _, l := range strings.Split(out, "\n") {
		had[l]++
	}
	for _, l := range lines[:len(lines)-1] {
		if had[l]--; had[l] < 0 {
			t.Errorf("a line kubectl did not print: %q", l)
		}
	}
	if n := utf8.RuneCountInString(got); n > modelResultChars {
		t.Errorf("%d characters", n)
	}
}

// An object without the annotation gets no line, one whose only annotation it is keeps no annotations key, and a warning
// kubectl printed stays in front.
func TestYAMLSpecFirst_OtherObjects(t *testing.T) {
	withYAMLSpecFirst(t, "true")
	for _, c := range []struct{ name, out, want string }{
		{"no annotation", "apiVersion: v1\ndata:\n  a: |\n    one\n\n    two\n  b: \"2\"\nkind: ConfigMap\nmetadata:\n  labels:\n    app: web\n  name: indexer\n  namespace: shop\n",
			"apiVersion: v1\nkind: ConfigMap\ndata:\n  a: |\n    one\n\n    two\n  b: \"2\"\nmetadata:\n  labels:\n    app: web\n  name: indexer\n  namespace: shop\n"},
		{"the only annotation", "apiVersion: v1\ndata:\n  WEB_WORKERS: \"6\"\nkind: ConfigMap\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"apiVersion\":\"v1\",\"data\":{\"WEB_WORKERS\":\"3\"},\"kind\":\"ConfigMap\",\"metadata\":{\"annotations\":{},\"name\":\"indexer\",\"namespace\":\"shop\"}}\n  name: indexer\n  namespace: shop\n",
			"apiVersion: v1\nkind: ConfigMap\ndata:\n  WEB_WORKERS: \"6\"\nmetadata:\n  name: indexer\n  namespace: shop\n# differs from last-applied: data.WEB_WORKERS: \"3\" → \"6\"\n"},
		{"nothing differs", "apiVersion: v1\ndata:\n  a: \"1\"\nkind: ConfigMap\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"apiVersion\":\"v1\",\"data\":{\"a\":\"1\"},\"kind\":\"ConfigMap\",\"metadata\":{\"name\":\"indexer\"}}\n    owner: me\n  name: indexer\n",
			"apiVersion: v1\nkind: ConfigMap\ndata:\n  a: \"1\"\nmetadata:\n  annotations:\n    owner: me\n  name: indexer\n# differs from last-applied: nothing (of the fields it set)\n"},
		{"a list at the top level, and a key before apiVersion", "allowVolumeExpansion: true\napiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  name: gp3\nmountOptions:\n- noatime\n- discard\nprovisioner: ebs.csi.aws.com\n",
			"apiVersion: storage.k8s.io/v1\nkind: StorageClass\nallowVolumeExpansion: true\nmountOptions:\n- noatime\n- discard\nprovisioner: ebs.csi.aws.com\nmetadata:\n  name: gp3\n"},
		{"a warning first", "Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice\napiVersion: v1\nkind: Endpoints\nmetadata:\n  name: indexer\nsubsets:\n- addresses:\n  - ip: 10.0.0.1\n",
			"Warning: v1 Endpoints is deprecated in v1.33+; use discovery.k8s.io/v1 EndpointSlice\napiVersion: v1\nkind: Endpoints\nsubsets:\n- addresses:\n  - ip: 10.0.0.1\nmetadata:\n  name: indexer\n"},
		{"an annotation quoted on its line", "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  annotations:\n    a: b\n    kubectl.kubernetes.io/last-applied-configuration: 'not JSON'\n    z: last\n  name: indexer\n",
			"apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  annotations:\n    a: b\n    z: last\n  name: indexer\n# differs from last-applied: not compared, the annotation does not read as JSON\n"},
		{"applied in another version", "apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"apiVersion\":\"autoscaling/v1\",\"kind\":\"HorizontalPodAutoscaler\",\"metadata\":{\"name\":\"indexer\"},\"spec\":{\"targetCPUUtilizationPercentage\":80}}\n  name: indexer\nspec:\n  maxReplicas: 3\n",
			"apiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nspec:\n  maxReplicas: 3\nmetadata:\n  name: indexer\n# differs from last-applied: not compared, it was applied as autoscaling/v1 HorizontalPodAutoscaler\n"},
	} {
		if got := readYAML(t, "x", c.out); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

// What does not read as one object kubectl printed answers as before, and so does everything that names a Secret.
func TestYAMLSpecFirst_WhatStaysAsItCame(t *testing.T) {
	withYAMLSpecFirst(t, "true")
	saved := outputMaxBytes
	t.Cleanup(func() { outputMaxBytes = saved })
	secret := "apiVersion: v1\ndata:\n  tls.key: " + fakeTLSB64 + "\nkind: Secret\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"apiVersion\":\"v1\",\"data\":{\"tls.key\":\"" + fakeSecretB64 + "\"},\"kind\":\"Secret\",\"metadata\":{\"name\":\"indexer\"}}\n  name: indexer\ntype: Opaque\n"
	for _, c := range []struct{ name, kind, out string }{
		{"a Secret", "secret", secret},
		{"a Secret by another name", "mysecrets", secret},
		{"a Secret by its type, whatever the text says", "secrets", "apiVersion: v1\ndata:\n  a: b\nkind: Other\nmetadata:\n  name: indexer\n"},
		{"a ConfigMap holding a Secret", "configmap", "apiVersion: v1\ndata:\n  manifest.yaml: |\n    kind: Secret\n    data:\n      tls.key: " + fakeTLSB64 + "\nkind: ConfigMap\nmetadata:\n  name: indexer\n"},
		{"a ConfigMap applied with a Secret in it", "configmap", "apiVersion: v1\ndata:\n  a: \"1\"\nkind: ConfigMap\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"apiVersion\":\"v1\",\"data\":{\"s.json\":\"{\\\"kind\\\":\\\"Secret\\\",\\\"data\\\":{\\\"tls.key\\\":\\\"" + fakeTLSB64 + "\\\"}}\"},\"kind\":\"ConfigMap\",\"metadata\":{\"name\":\"indexer\"}}\n  name: indexer\n"},
		{"a store of Secrets", "externalsecret", "apiVersion: external-secrets.io/v1\nkind: ExternalSecret\nmetadata:\n  name: indexer\nspec:\n  secretStoreRef:\n    kind: SecretStore\n    name: aws\n"},
		{"a list", "deployments", "apiVersion: v1\nitems:\n- apiVersion: apps/v1\n  kind: Deployment\n  metadata:\n    name: a\nkind: List\nmetadata:\n  resourceVersion: \"\"\n"},
		{"two documents", "configmap", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: a\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: b\n"},
		{"no YAML", "configmap", "error: something kubectl said\n"},
		{"a table", "configmap", "NAME   DATA   AGE\nindexer   1   3d\n"},
		{"flow style", "configmap", "{apiVersion: v1, kind: ConfigMap, metadata: {name: indexer}}\n"},
		{"a quoted key", "configmap", "\"apiVersion\": v1\nkind: ConfigMap\nmetadata:\n  name: indexer\n"},
		{"nothing", "configmap", ""},
		{"a long one", "configmap", "apiVersion: v1\ndata:\n  a: " + strings.Repeat("x", yamlShapeMaxBytes) + "\nkind: ConfigMap\nmetadata:\n  name: indexer\n"},
	} {
		if got := readYAML(t, c.kind, c.out); got != c.out {
			t.Errorf("%s changed:\n%s", c.name, got)
		}
	}
	out := indexerYAML(t)
	outputMaxBytes = len(out) - 400
	if got, want := readYAML(t, "statefulset", out), capOutput([]byte(out)); got != want {
		t.Errorf("a cut answer changed")
	}
}

// A Secret reads as it does with the switch off, its values masked in every form, cut or whole.
func TestYAMLSpecFirst_ASecretsValuesStayMasked(t *testing.T) {
	saved := outputMaxBytes
	t.Cleanup(func() { outputMaxBytes = saved })
	toolServerForSecrets(t, nil)
	whole := "apiVersion: v1\ndata:\n  tls.key: " + fakeTLSB64 + "\n  other: " + fakeSecretB64 + "\nkind: Secret\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      {\"apiVersion\":\"v1\",\"kind\":\"Secret\",\"stringData\":{\"conf\":\"{ value = " + fakeBracePlan + " }\"}}\n  name: db\n"
	for _, limit := range []int{saved, strings.Index(whole, "kind") - 2, strings.Index(whole, fakeBracePlan) + 4} {
		outputMaxBytes = limit
		for _, kind := range []string{"secret", "secrets", "Secret", "secret.v1", "secrets,configmaps"} {
			fakeKubectl(t, func([]string) (string, error) { return whole, nil })
			answers := map[string]ToolCallResponse{}
			for _, value := range []string{"false", "true"} {
				withYAMLSpecFirst(t, value)
				answers[value] = callTool(t, "k8s_get_resource_yaml", args{"resource_type": kind, "resource_name": "db"})
			}
			on, off := answers["true"], answers["false"]
			if on.Content != off.Content || !reflect.DeepEqual(on.Redacted, off.Redacted) || on.Error != off.Error {
				t.Errorf("%s, %d bytes: on\n%s\noff\n%s", kind, limit, on.Content, off.Content)
			}
			if v := secretValueIn(on); v != "" {
				t.Errorf("%s, %d bytes: the answer holds %q", kind, limit, v)
			}
		}
	}
}

// What the masking takes out of kubectl's text is not in the answer with the spec first, nor in its last line.
func TestYAMLSpecFirst_NoCredentialInTheLine(t *testing.T) {
	withYAMLSpecFirst(t, "true")
	redactOpts.PII = true
	toolServerForSecrets(t, nil)
	was := map[string]string{
		"password": "planted-db-pass-1", "db.conf": "host=db\npassword=planted-db-pass-1\nworkers=3\nowner=ann.planted@example.com\n",
		"app.yaml": "log: info\ndb:\n  password: planted-db-pass-1\n  pool: 10\n" + strings.Repeat("# padding\n", 12),
		"url":      "postgres://app:planted-db-pass-1@db:5432/app", "auth": "Authorization: Bearer plantedtoken0123456789abcdef", "key": plantedAWSKey,
		"contact": "ann.planted@example.com", "phone": "010-2222-3333", "mode": "slow", "jwt": "none",
	}
	is := map[string]string{
		"password": "planted-db-pass-2", "db.conf": "host=db\npassword=planted-db-pass-2\nworkers=6\nowner=bob.planted@example.com\n",
		"app.yaml": "log: info\ndb:\n  password: planted-db-pass-2\n  pool: 20\n" + strings.Repeat("# padding\n", 12),
		"url":      "postgres://app:planted-db-pass-2@db:5432/app", "auth": "Authorization: Bearer plantedtoken9876543210zyxwvu", "key": plantedAWSKey[:19] + "9",
		"contact": "bob.planted@example.com", "phone": "010-2222-4444", "mode": "fast", "jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.c2lnbmF0dXJlLXBsYW50ZWQ",
	}
	raw, _ := json.Marshal(map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "data": was, "metadata": map[string]interface{}{"name": "indexer"}})
	out := "apiVersion: v1\ndata:\n"
	keys := make([]string, 0, len(is))
	for k := range is {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v, _ := json.Marshal(is[k])
		if strings.Contains(is[k], "\n") {
			out += "  " + k + ": |\n    " + strings.ReplaceAll(strings.TrimSuffix(is[k], "\n"), "\n", "\n    ") + "\n"
		} else {
			out += "  " + k + ": " + string(v) + "\n"
		}
	}
	out += "kind: ConfigMap\nmetadata:\n  annotations:\n    kubectl.kubernetes.io/last-applied-configuration: |\n      " + string(raw) + "\n  name: indexer\n"
	fakeKubectl(t, func([]string) (string, error) { return out, nil })
	resp := callTool(t, "k8s_get_resource_yaml", args{"resource_type": "configmap", "resource_name": "indexer"})
	lines := strings.Split(strings.TrimSuffix(resp.Content, "\n"), "\n")
	last := lines[len(lines)-1]
	t.Log(last)
	for _, v := range append([]string{"planted-db-pass", plantedAWSKey, plantedAWSKey[:19], "eyJhbGci", "2222-4444", "planted@", "plantedtoken"}, plantedValues...) {
		if strings.Contains(resp.Content, v) {
			t.Errorf("%q is in the answer: %s", v, resp.Content)
		}
	}
	for _, want := range []string{
		"data.password (changed, value masked)", "data.url (changed, value masked)", "data.auth (changed, value masked)", "data.key (changed, value masked)",
		`data["db.conf"] (changed, personal data not shown)`, "data.contact (changed, personal data not shown)", "data.phone (changed, personal data not shown)",
		`data.mode: "slow" → "fast"`, `data.jwt: "none" → "<REDACTED:jwt>"`,
		`data["app.yaml"]: …word>\n  pool: 10\n`, `→ …word>\n  pool: 20\n`,
	} {
		if !strings.Contains(last, want) {
			t.Errorf("the line does not hold %q: %s", want, last)
		}
	}
}

func TestDiffersFromLastApplied(t *testing.T) {
	withYAMLSpecFirst(t, "true")
	redactOpts.PII = true
	object := func(kind, spec string) map[string]interface{} {
		var m map[string]interface{}
		if err := utilyaml.Unmarshal([]byte(`{"apiVersion":"v1","kind":"`+kind+`","metadata":{"name":"a","labels":{"x":"1","added":"2"},"annotations":{"team":"b"}},`+spec+`}`), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	for _, c := range []struct{ name, kind, was, is, want string }{
		{"defaults are not differences", "Deployment", `"spec":{"replicas":2,"template":{"spec":{"containers":[{"name":"a","image":"i:1"}]}}}`,
			`"spec":{"replicas":2,"progressDeadlineSeconds":600,"strategy":{"type":"RollingUpdate"},"template":{"spec":{"containers":[{"name":"a","image":"i:1","imagePullPolicy":"IfNotPresent"}],"dnsPolicy":"ClusterFirst"}}},"status":{"replicas":1}`, ""},
		{"amounts in another form", "Deployment", `"spec":{"c":[{"name":"a","resources":{"limits":{"cpu":"1000m","memory":"1024Mi"},"requests":{"cpu":0.5}}}]}`,
			`"spec":{"c":[{"name":"a","resources":{"limits":{"cpu":"1","memory":"1Gi"},"requests":{"cpu":"500m"}}}]}`, ""},
		{"an amount that changed", "Deployment", `"spec":{"c":[{"name":"a","resources":{"limits":{"cpu":"1000m"}}}]}`, `"spec":{"c":[{"name":"a","resources":{"limits":{"cpu":"2"}}}]}`,
			`spec.c[a].resources.limits.cpu: "1000m" → "2"`},
		{"a variable is no amount", "Deployment", `"spec":{"env":[{"name":"V","value":"1.0"}]}`, `"spec":{"env":[{"name":"V","value":"1"}]}`, `spec.env[V].value: "1.0" → "1"`},
		{"a number and its text", "Service", `"spec":{"ports":[{"port":80,"targetPort":"8080"}]}`, `"spec":{"ports":[{"port":80,"targetPort":8080,"protocol":"TCP"}]}`, ""},
		{"what is empty leaves nothing", "Deployment", `"spec":{"a":{},"b":[],"c":"","d":null,"e":false,"f":{"creationTimestamp":null},"g":0}`, `"spec":{}`, ""},
		{"a field that went", "Deployment", `"spec":{"minReadySeconds":10}`, `"spec":{}`, `spec.minReadySeconds: 10 → (absent)`},
		{"entries by name, in another order", "Deployment", `"spec":{"volumes":[{"name":"a","emptyDir":{"medium":"Memory"}},{"name":"b"}]}`, `"spec":{"volumes":[{"name":"b"},{"name":"a","emptyDir":{"medium":""}}]}`,
			`spec.volumes[a].emptyDir.medium: "Memory" → ""`},
		{"an entry that came", "Deployment", `"spec":{"env":[{"name":"A","value":"1"}]}`, `"spec":{"env":[{"name":"A","value":"1"},{"name":"B","value":"2"}]}`, `spec.env[B]: (absent) → {"name":"B","value":"2"}`},
		{"a list that came", "Deployment", `"spec":{"c":[{"name":"a"}]}`, `"spec":{"c":[{"name":"a","env":[{"name":"B","value":"2"}],"ports":[{"containerPort":1}]}]}`, `spec.c[a].env: (absent) → [{"name":"B","value":"2"}]`},
		{"mounts of one volume at two paths", "Deployment", `"spec":{"volumeMounts":[{"name":"v","mountPath":"/a"},{"name":"v","mountPath":"/b","subPath":"x"}]}`, `"spec":{"volumeMounts":[{"name":"v","mountPath":"/a"},{"name":"v","mountPath":"/b","subPath":"y"}]}`,
			`spec.volumeMounts[/b].subPath: "x" → "y"`},
		{"arguments", "Deployment", `"spec":{"args":["--workers=3","--log=info"]}`, `"spec":{"args":["--workers=6","--log=info"]}`, `spec.args[0]: "--workers=3" → "--workers=6"`},
		{"arguments of another number", "Deployment", `"spec":{"args":["a","b"]}`, `"spec":{"args":["a"]}`, `spec.args: ["a","b"] → ["a"]`},
		{"a key of a map of plain values", "ConfigMap", `"data":{"a":"1"}`, `"data":{"a":"1","b.c":"2"}`, `data["b.c"]: (absent) → "2"`},
		{"a map of plain values that came", "Deployment", `"spec":{"template":{"metadata":{}}}`, `"spec":{"template":{"metadata":{"annotations":{"r":"1"},"labels":{"l":"2"}}}}`,
			`spec.template.metadata.annotations.r: (absent) → "1"; spec.template.metadata.labels.l: (absent) → "2"`},
		{"a Job's own labels", "Job", `"spec":{"template":{"metadata":{}}}`, `"spec":{"selector":{"matchLabels":{"u":"1"}},"template":{"metadata":{"labels":{"batch.kubernetes.io/job-name":"a"}}}}`, ""},
		{"a Pod's own mounts", "Pod", `"spec":{"volumes":[{"name":"a"}],"c":[{"name":"a"}]}`, `"spec":{"volumes":[{"name":"a"},{"name":"kube-api-access-x"}],"c":[{"name":"a","volumeMounts":[{"name":"kube-api-access-x"}]}]}`, ""},
		{"another type", "Deployment", `"spec":{"a":{"b":1}}`, `"spec":{"a":"x"}`, `spec.a: {"b":1} → "x"`},
		{"a long text, from where it parts", "ConfigMap", `"data":{"f":"` + strings.Repeat("k", 200) + `workers: 3` + strings.Repeat("z", 200) + `"}`, `"data":{"f":"` + strings.Repeat("k", 200) + `workers: 30` + strings.Repeat("z", 200) + `"}`,
			`data.f: …kkkkkworkers: 3` + strings.Repeat("z", 45) + `… → …kkkkkworkers: 30` + strings.Repeat("z", 44) + `…`},
		{"a phone number at the start of a line", "ConfigMap", `"data":{"f":"a\n010-2222-3333\nworkers=3"}`, `"data":{"f":"a\n010-2222-3333\nworkers=6"}`, `data.f (changed, personal data not shown)`},
		{"a key cpu of a ConfigMap is text", "ConfigMap", `"data":{"cpu":"1000m"}`, `"data":{"cpu":"1"}`, `data.cpu: "1000m" → "1"`},
		{"numbers past 2^53", "Deployment", `"spec":{"n":9007199254740993}`, `"spec":{"n":9007199254740993}`, ""},
	} {
		applied, live := object(c.kind, c.was), object(c.kind, c.is)
		delete(applied["metadata"].(map[string]interface{})["labels"].(map[string]interface{}), "added")
		raw, _ := json.Marshal(applied)
		live["metadata"].(map[string]interface{})["annotations"].(map[string]interface{})[lastAppliedAnnotation] = string(raw)
		got := differsFromLastApplied(live)
		want := differsLead + c.want
		if c.want == "" {
			want = differsLead + "nothing (of the fields it set)"
		}
		if got != want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, want)
		}
	}
}

// The line is one line of a bounded length however much differs and whatever the keys hold.
func TestDiffersFromLastApplied_OneLineOfABoundedLength(t *testing.T) {
	withYAMLSpecFirst(t, "true")
	was, is := map[string]interface{}{}, map[string]interface{}{}
	for i := 0; i < 400; i++ {
		k := fmt.Sprintf("key-%03d\n%s", i, strings.Repeat("k", 40))
		was[k], is[k] = strings.Repeat("a", 500), strings.Repeat("b", 500)
	}
	raw, _ := json.Marshal(map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "data": was})
	line := differsFromLastApplied(map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "data": is,
		"metadata": map[string]interface{}{"name": "a", "annotations": map[string]interface{}{lastAppliedAnnotation: string(raw)}}})
	if n := utf8.RuneCountInString(line); n > differsLineChars+200 || strings.ContainsAny(line, "\n\r") || !strings.Contains(line, "; and 39") {
		t.Errorf("%d characters: %s", n, line)
	}
}
