// gitops_status reads Argo CD Application objects as the user and condenses
// them to what an operator asks: sync and health, the last operation, error
// conditions and the resources that are out of sync or unhealthy. Argo CD
// often runs in another cluster than the workloads it deploys, so the tool
// answers for the cluster it is called on and says so when the CRD is absent.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

const (
	argoApplicationsType = "applications.argoproj.io"
	gitopsAppsDefault    = 50
	gitopsAppsCap        = 100
	gitopsResourcesCap   = 10
	gitopsConditionsCap  = 5
	gitopsAlternative    = "k8s_get_resources / k8s_describe_resource for the workloads themselves, helm_read for Helm releases."
)

func handleGitopsStatus(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	name := argString(args, "name", "")
	if name != "" && namespace == "" {
		return "", wrapBadRequest("name needs namespace (the Application's own namespace, usually argocd)")
	}
	cmd, scope, err := listArgs(ctx, map[string]interface{}{"resource_type": argoApplicationsType, "namespace": namespace})
	if err != nil {
		return "", err
	}
	if name != "" {
		cmd = append([]string{"get", argoApplicationsType, name}, cmd[2:]...)
	}
	list, res, err := getJSONList(ctx, headers, cmd, "Application", namespace)
	if err != nil {
		return "", err
	}
	if res != "" {
		var failure map[string]interface{}
		if json.Unmarshal([]byte(res), &failure) == nil && failure["status"] == "unknown_kind" {
			return unavailableResult("gitops_status",
				"Argo CD is not installed in this cluster (no applications.argoproj.io). Application objects live where Argo CD runs — call gitops_status on that cluster (the management cluster when Argo CD is central).",
				gitopsAlternative)
		}
		return res, nil
	}
	items := itemsOf(list)
	if items == nil && list["metadata"] != nil {
		items = []interface{}{list}
	}

	project := argString(args, "project", "")
	destNS := argString(args, "destination_namespace", "")
	onlyProblems := argBool(args, "only_problems")
	limit := argInt(args, "limit", gitopsAppsDefault)
	if limit < 1 || limit > gitopsAppsCap {
		limit = gitopsAppsCap
	}

	syncCounts := map[string]int{}
	healthCounts := map[string]int{}
	apps := make([]map[string]interface{}, 0, len(items))
	for _, it := range items {
		app, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		s := summarizeApplication(app)
		if project != "" && fmt.Sprint(s["project"]) != project {
			continue
		}
		if destNS != "" {
			dest, _ := s["destination"].(map[string]interface{})
			if fmt.Sprint(dest["namespace"]) != destNS {
				continue
			}
		}
		syncCounts[s["sync_status"].(string)]++
		healthCounts[s["health_status"].(string)]++
		if onlyProblems && !s["problem"].(bool) {
			continue
		}
		apps = append(apps, s)
	}
	// Problems first, then by namespace/name, so a capped list keeps what matters.
	sort.SliceStable(apps, func(i, j int) bool {
		pi, pj := apps[i]["problem"].(bool), apps[j]["problem"].(bool)
		if pi != pj {
			return pi
		}
		return fmt.Sprint(apps[i]["namespace"], "/", apps[i]["name"]) < fmt.Sprint(apps[j]["namespace"], "/", apps[j]["name"])
	})
	matched := len(apps)
	truncated := false
	if len(apps) > limit {
		apps = apps[:limit]
		truncated = true
	}
	for _, a := range apps {
		delete(a, "sync_status")
		delete(a, "health_status")
		delete(a, "problem")
	}
	out := map[string]interface{}{
		"resource":           argoApplicationsType,
		"scope":              scope,
		"applications_total": len(items),
		"counts":             map[string]interface{}{"sync": syncCounts, "health": healthCounts},
		"matched":            matched,
		"applications":       apps,
	}
	if project != "" || destNS != "" || onlyProblems || name != "" {
		out["filter"] = map[string]interface{}{"name": name, "project": project, "destination_namespace": destNS, "only_problems": onlyProblems}
	}
	if truncated {
		out["truncated"] = true
	}
	if len(items) == 0 {
		out["hint"] = "No Argo CD Applications in " + scope + ". If Argo CD runs in another cluster (a management cluster), call gitops_status there; the Application's own namespace is usually argocd."
	}
	return marshalJSON(out)
}

// summarizeApplication keeps the fields an operator reads first. The two
// *_status keys and "problem" drive sorting and filtering and are removed
// from the final output.
func summarizeApplication(app map[string]interface{}) map[string]interface{} {
	meta, _ := app["metadata"].(map[string]interface{})
	spec, _ := app["spec"].(map[string]interface{})
	status, _ := app["status"].(map[string]interface{})
	out := map[string]interface{}{
		"name":      meta["name"],
		"namespace": meta["namespace"],
		"project":   spec["project"],
	}
	if src, ok := spec["source"].(map[string]interface{}); ok {
		out["source"] = sourceSummary(src)
	}
	if srcs, ok := spec["sources"].([]interface{}); ok && len(srcs) > 0 {
		list := make([]map[string]interface{}, 0, len(srcs))
		for _, s := range srcs {
			if m, ok := s.(map[string]interface{}); ok {
				list = append(list, sourceSummary(m))
			}
		}
		out["sources"] = list
	}
	if dest, ok := spec["destination"].(map[string]interface{}); ok {
		d := map[string]interface{}{}
		for _, k := range []string{"server", "name", "namespace"} {
			if v, ok := dest[k].(string); ok && v != "" {
				d[k] = v
			}
		}
		out["destination"] = d
	}
	if policy, ok := spec["syncPolicy"].(map[string]interface{}); ok {
		if auto, ok := policy["automated"].(map[string]interface{}); ok {
			out["automated"] = map[string]interface{}{"prune": auto["prune"] == true, "self_heal": auto["selfHeal"] == true}
		}
	}

	sync, _ := status["sync"].(map[string]interface{})
	health, _ := status["health"].(map[string]interface{})
	syncStatus := stringOr(sync["status"], "Unknown")
	healthStatus := stringOr(health["status"], "Unknown")
	out["sync"] = map[string]interface{}{"status": syncStatus, "revision": shortRevision(sync["revision"])}
	h := map[string]interface{}{"status": healthStatus}
	if msg, _ := health["message"].(string); msg != "" {
		h["message"] = msg
	}
	out["health"] = h
	problem := syncStatus != "Synced" || healthStatus != "Healthy"

	if op, ok := status["operationState"].(map[string]interface{}); ok {
		o := map[string]interface{}{"phase": op["phase"]}
		for k, key := range map[string]string{"message": "message", "startedAt": "started_at", "finishedAt": "finished_at", "retryCount": "retry_count"} {
			if v := op[k]; v != nil && v != "" {
				o[key] = v
			}
		}
		if phase, _ := op["phase"].(string); phase == "Failed" || phase == "Error" {
			problem = true
		}
		out["operation"] = o
	}
	if conds, ok := status["conditions"].([]interface{}); ok && len(conds) > 0 {
		list := make([]map[string]interface{}, 0, gitopsConditionsCap)
		for _, c := range conds {
			m, _ := c.(map[string]interface{})
			if t, _ := m["type"].(string); strings.HasSuffix(t, "Error") {
				problem = true
			}
			if len(list) < gitopsConditionsCap {
				list = append(list, map[string]interface{}{"type": m["type"], "message": m["message"]})
			}
		}
		out["conditions"] = list
		out["conditions_total"] = len(conds)
	}
	if resources, ok := status["resources"].([]interface{}); ok {
		problems := make([]map[string]interface{}, 0)
		for _, r := range resources {
			m, _ := r.(map[string]interface{})
			rs, _ := m["status"].(string)
			rh, _ := m["health"].(map[string]interface{})
			hs, _ := rh["status"].(string)
			if (rs == "" || rs == "Synced") && (hs == "" || hs == "Healthy") {
				continue
			}
			p := map[string]interface{}{"kind": m["kind"], "name": m["name"], "sync": rs, "health": hs}
			if ns, _ := m["namespace"].(string); ns != "" {
				p["namespace"] = ns
			}
			if msg, _ := rh["message"].(string); msg != "" {
				p["message"] = msg
			}
			problems = append(problems, p)
		}
		out["resources"] = map[string]interface{}{"total": len(resources), "problems": len(problems)}
		if len(problems) > 0 {
			if len(problems) > gitopsResourcesCap {
				problems = problems[:gitopsResourcesCap]
				out["problem_resources_truncated"] = true
			}
			out["problem_resources"] = problems
		}
	}
	if ra := status["reconciledAt"]; ra != nil {
		out["reconciled_at"] = ra
	}
	out["sync_status"] = syncStatus
	out["health_status"] = healthStatus
	out["problem"] = problem
	return out
}

func sourceSummary(src map[string]interface{}) map[string]interface{} {
	s := map[string]interface{}{}
	for k, key := range map[string]string{"repoURL": "repo", "path": "path", "chart": "chart", "targetRevision": "target_revision"} {
		if v, ok := src[k].(string); ok && v != "" {
			s[key] = v
		}
	}
	return s
}

func stringOr(v interface{}, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}

func shortRevision(v interface{}) string {
	s, _ := v.(string)
	if len(s) > 8 && !strings.ContainsAny(s, "./") {
		return s[:8]
	}
	return s
}
