package main

import (
	"errors"
	"strings"
	"testing"
)

// Every argument that reaches kubectl's argv must look like the name, key or
// verb it stands for; a flag in that position is refused before kubectl runs.
func TestValidateToolArgs(t *testing.T) {
	ok := []map[string]interface{}{
		{"resource_type": "pods", "resource_name": "web-0", "namespace": "team-a", "output": "json"},
		{"resource_type": "deployments.apps", "resource_name": "api", "output": "wide"},
		{"resource_type": "pods,services", "output": "name"},
		{"resource_type": "Pod", "resource_name": "web-0"},
		{"resource_type": "Deployment.apps", "resource_name": "api"},
		{"resource_type": "clusterroles", "resource_name": "system:node"},
		{"resource_type": "all", "namespace": "kube-system", "output": "jsonpath={.items[*].metadata.name}"},
		{"resource_type": "pods", "output": "custom-columns=NAME:.metadata.name"},
		{"pod_name": "web-0", "namespace": "default", "container": "app", "tail_lines": 100},
		{"service_name": "api", "namespace": "team-a", "port": "8080"},
		{"resource_type": "deployment", "resource_name": "api", "action": "undo", "revision": 2, "timeout": "5m"},
		{"resource_type": "deployment", "resource_name": "api", "patch_type": "merge"},
		{"resource_type": "pods", "resource_name": "web-0", "labels": map[string]interface{}{"app.kubernetes.io/name": "web", "tier": "front_end.v1", "empty": ""}},
		{"resource_type": "pods", "resource_name": "web-0", "annotations": map[string]interface{}{"kubeast.io/note": "any text with spaces"}},
		{"resource_type": "pods", "resource_name": "web-0", "keys": []interface{}{"app", "example.com/owner"}},
		{"pod_name": "web-0", "command": []interface{}{"sh", "-c", "ls -la"}},
		{"resource_type": "deployment", "resource_name": "api", "replicas": 3},
	}
	for i, args := range ok {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("ok[%d] %v: unexpected error %v", i, args, err)
		}
	}

	bad := []struct {
		args map[string]interface{}
		want string
	}{
		{map[string]interface{}{"resource_type": "--kubeconfig=/tmp/tool-server-kubeconfig-prod"}, "resource_type"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "--as-group=system:masters"}, "resource_name"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "-n"}, "resource_name"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "web/../x"}, "resource_name"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "web 0"}, "resource_name"},
		{map[string]interface{}{"resource_type": "pods", "namespace": "--all-namespaces"}, "namespace"},
		{map[string]interface{}{"resource_type": "pods", "namespace": "Team_A"}, "namespace"},
		{map[string]interface{}{"pod_name": "web-0", "container": "--previous"}, "container"},
		{map[string]interface{}{"resource_type": "pods", "output": "custom-columns-file=/etc/passwd"}, "output"},
		{map[string]interface{}{"resource_type": "pods", "output": "go-template-file=/tmp/t"}, "output"},
		{map[string]interface{}{"resource_type": "pods", "output": "--kubeconfig=/x"}, "output"},
		{map[string]interface{}{"resource_type": "deployment", "resource_name": "api", "action": "--to-revision=1"}, "action"},
		{map[string]interface{}{"resource_type": "deployment", "resource_name": "api", "action": "delete"}, "action"},
		{map[string]interface{}{"resource_type": "deployment", "resource_name": "api", "patch_type": "--local"}, "patch_type"},
		{map[string]interface{}{"resource_type": "deployment", "resource_name": "api", "timeout": "--force"}, "timeout"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "web-0", "labels": map[string]interface{}{"--overwrite": "x"}}, "labels key"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "web-0", "labels": map[string]interface{}{"app": "has space"}}, "labels value"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "web-0", "annotations": map[string]interface{}{"-x": "1"}}, "annotations key"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": "web-0", "keys": []interface{}{"--all"}}, "keys"},
		{map[string]interface{}{"resource_type": "pods", "resource_name": strings.Repeat("a", 254)}, "resource_name"},
		{map[string]interface{}{"service_name": "--raw"}, "service_name"},
		{map[string]interface{}{"name": "-h"}, "name"},
	}
	for i, tc := range bad {
		err := validateToolArgs(tc.args)
		if err == nil {
			t.Errorf("bad[%d] %v: expected an error", i, tc.args)
			continue
		}
		if !errors.Is(err, errBadRequest) {
			t.Errorf("bad[%d]: error must be a bad request, got %v", i, err)
		}
		if !strings.HasPrefix(err.Error(), "bad request: "+tc.want+":") {
			t.Errorf("bad[%d]: error should name field %q, got %v", i, tc.want, err)
		}
	}
}
