package helm

import (
	"strings"
	"testing"
)

const sampleManifest = `
---
# Source: nginx/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-nginx
  namespace: test
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: nginx
          image: nginx:1.25.0
        - name: sidecar
          image: busybox:1.36
      initContainers:
        - name: init
          image: alpine:3.19
---
# Source: nginx/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: test-nginx
  namespace: test
---
# Source: nginx/templates/ns.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: observability
---
# Source: nginx/templates/cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: test-cron
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: worker
              image: worker:v2
`

func TestSplitManifest(t *testing.T) {
	objs, err := splitManifest(sampleManifest)
	if err != nil {
		t.Fatalf("splitManifest: %v", err)
	}
	if len(objs) != 4 {
		t.Fatalf("want 4 objects, got %d", len(objs))
	}
	kinds := make([]string, 0, len(objs))
	for _, o := range objs {
		kinds = append(kinds, o.Kind)
	}
	joined := strings.Join(kinds, ",")
	want := "Deployment,Service,Namespace,CronJob"
	if joined != want {
		t.Errorf("kinds = %q, want %q", joined, want)
	}
}

func TestIsClusterScoped(t *testing.T) {
	cases := map[string]bool{
		"Namespace":                true,
		"ClusterRole":              true,
		"CustomResourceDefinition": true,
		"Pod":                      false,
		"Deployment":               false,
		"ConfigMap":                false,
	}
	for kind, want := range cases {
		if got := isClusterScoped(kind); got != want {
			t.Errorf("isClusterScoped(%q) = %v, want %v", kind, got, want)
		}
	}
}

func TestSplitManifestIgnoresMalformed(t *testing.T) {
	// A single malformed YAML document should not fail the whole parse;
	// well-formed siblings are still returned.
	in := sampleManifest + "\n---\nthis is not: {valid: yaml:}: [\n"
	objs, err := splitManifest(in)
	if err != nil {
		t.Fatalf("splitManifest: %v", err)
	}
	if len(objs) < 4 {
		t.Errorf("malformed doc should not drop earlier ones, got %d", len(objs))
	}
}
