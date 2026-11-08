package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// A workload drawer lists the pods of the workload's whole selector: its describe answer gives the selector's
// matchExpressions beside its matchLabels, also when it has expressions only, so the pod table is read as the
// controller selects (the drawer joins both with selectorText).
func TestAWorkloadsAnswerGivesItsSelectorsExpressions(t *testing.T) {
	type describe func(s *Service, ctx context.Context) (map[string]interface{}, error)
	kinds := []struct {
		kind, path, list string
		read             describe
	}{
		{"Deployment", "/apis/apps/v1/namespaces/ns/deployments/x", `"replicas":1`, func(s *Service, ctx context.Context) (map[string]interface{}, error) {
			return s.DescribeDeployment(ctx, "ns", "x")
		}},
		{"StatefulSet", "/apis/apps/v1/namespaces/ns/statefulsets/x", `"replicas":1`, func(s *Service, ctx context.Context) (map[string]interface{}, error) {
			return s.DescribeStatefulSet(ctx, "ns", "x")
		}},
		{"DaemonSet", "/apis/apps/v1/namespaces/ns/daemonsets/x", ``, func(s *Service, ctx context.Context) (map[string]interface{}, error) {
			return s.DescribeDaemonSet(ctx, "ns", "x")
		}},
		{"ReplicaSet", "/apis/apps/v1/namespaces/ns/replicasets/x", `"replicas":1`, func(s *Service, ctx context.Context) (map[string]interface{}, error) {
			return s.DescribeReplicaSet(ctx, "ns", "x")
		}},
		{"Job", "/apis/batch/v1/namespaces/ns/jobs/x", `"manualSelector":true`, func(s *Service, ctx context.Context) (map[string]interface{}, error) {
			return s.DescribeJob(ctx, "ns", "x")
		}},
	}
	selectors := []struct {
		name, selector, wantLabels, wantExpressions string
	}{
		{"labels and an expression", `{"matchLabels":{"app":"web"},"matchExpressions":[{"key":"tier","operator":"In","values":["front"]}]}`, `{"app":"web"}`, `[{"key":"tier","operator":"In","values":["front"]}]`},
		{"an expression only", `{"matchExpressions":[{"key":"tier","operator":"Exists"}]}`, `{}`, `[{"key":"tier","operator":"Exists","values":null}]`},
		{"labels only", `{"matchLabels":{"app":"web"}}`, `{"app":"web"}`, `null`},
	}
	for _, k := range kinds {
		for _, sel := range selectors {
			spec := `"selector":` + sel.selector + `,"template":{"metadata":{"labels":{"app":"web","tier":"front"}},"spec":{"containers":[{"name":"c","image":"busybox"}]}}`
			if k.list != "" {
				spec = k.list + "," + spec
			}
			api := "apps/v1"
			if k.kind == "Job" {
				api = "batch/v1"
			}
			object := fmt.Sprintf(`{"apiVersion":%q,"kind":%q,"metadata":{"name":"x","namespace":"ns","uid":"u1"},"spec":{%s},"status":{}}`, api, k.kind, spec)
			s := oneObjectAPI(t, map[string]string{k.path: object})
			answer, err := k.read(s, context.Background())
			if err != nil {
				t.Fatalf("%s with %s: %v", k.kind, sel.name, err)
			}
			labels, _ := json.Marshal(answer["selector"])
			expressions, _ := json.Marshal(answer["selector_expressions"])
			if string(labels) != sel.wantLabels || string(expressions) != sel.wantExpressions {
				t.Errorf("%s with %s: selector %s, selector_expressions %s; want %s and %s", k.kind, sel.name, labels, expressions, sel.wantLabels, sel.wantExpressions)
			}
		}
	}
}
