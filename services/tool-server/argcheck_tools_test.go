package main

import (
	"errors"
	"testing"
)

// The arguments the log, event, find and explain tools add are checked like
// every other value that reaches kubectl's argv.
func TestValidateToolArgs_NewArguments(t *testing.T) {
	ok := []map[string]interface{}{
		{"since": "10m"}, {"since": "1h30m"}, {"since": "5s"},
		{"field_selector": "type=Warning"}, {"field_selector": "involvedObject.name=web,type!=Normal"}, {"field_selector": "reason==BackOff"},
		{"kind": "Pod"}, {"kind": "deployments"},
		{"query": "web"}, {"query": "app=web"}, {"query": "kubeast-auth"}, {"query": "app.kubernetes.io/name=web"},
		{"resource": "deployments"}, {"resource": "deployments.spec.strategy"}, {"resource": "pods.spec.containers.resources"},
		{"api_version": "v1"}, {"api_version": "apps/v1"}, {"api_version": "autoscaling/v2beta2"},
		{"kinds": "pods,services"}, {"kinds": []interface{}{"pods", "deployments.apps"}},
		{"grep": "connection refused"},
	}
	for _, args := range ok {
		if err := validateToolArgs(args); err != nil {
			t.Errorf("%v should pass: %v", args, err)
		}
	}
	bad := []map[string]interface{}{
		{"since": "10x"}, {"since": "200h"}, {"since": "--since=1h"}, {"since": "0s"},
		{"field_selector": "spec.nodeName=a"}, {"field_selector": "type=a b"}, {"field_selector": "type"}, {"field_selector": "type=Warning,"},
		{"kind": "pod-s"}, {"kind": "--all"},
		{"query": "w"}, {"query": "a;b"}, {"query": "--kubeconfig=/x"}, {"query": "a b"},
		{"resource": "--help"}, {"resource": "deployments..spec"}, {"resource": "pods/exec"},
		{"api_version": "apps/v1;x"}, {"api_version": "--api-version=v1"},
		{"kinds": "--all"}, {"kinds": []interface{}{"pods", "-n"}},
		{"grep": "a\nb"},
	}
	for _, args := range bad {
		if err := validateToolArgs(args); !errors.Is(err, errBadRequest) {
			t.Errorf("%v should be refused, got %v", args, err)
		}
	}
}
