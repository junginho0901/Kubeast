// Read tool handler 모음. main.go 에서 추출 (Phase 3.6.f).
//
// 11개 read 도구: get_resources / get_resource_yaml / describe / pod_logs /
// get_events / get_available_api_resources / get_cluster_configuration /
// get_cluster_overview / get_node_metrics / get_pod_metrics /
// check_service_connectivity. 모두 args 파서 + runKubectl + parse 헬퍼만 사용.
// find_resource / explain 은 handlers_find.go; kubectl 실패를 모델이 쓸 수 있는
// 결과(not_found·unknown_kind·unavailable…)로 바꾸는 쪽은 notfound.go.

package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// maxLogTailLines caps a pod-logs tool call; the output is also capped in
// bytes by runKubectl (TOOL_OUTPUT_MAX_BYTES) and `--limit-bytes`.
const maxLogTailLines = 2000

// Secrets are readable for the assistant, but never their values: every tool
// result passes through services/pkg/redact in handleCall, which empties
// data/stringData of any Secret document and masks credentials elsewhere
// (OWASP LLM02). The UI path gates the same data behind resource.secret.reveal
// + audit.

func handleGetResources(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	if resourceType == "" {
		return "", wrapBadRequest("resource_type parameter is required")
	}
	resourceName := argString(args, "resource_name", "")
	namespace := argString(args, "namespace", "")
	allNamespaces := argBool(args, "all_namespaces")
	output := argString(args, "output", "wide")

	cmdArgs := []string{"get", resourceType}
	if resourceName != "" {
		cmdArgs = append(cmdArgs, resourceName)
	}

	if allNamespaces {
		cmdArgs = append(cmdArgs, "--all-namespaces")
	} else if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}

	if output != "" {
		cmdArgs = append(cmdArgs, "-o", output)
	} else {
		cmdArgs = append(cmdArgs, "-o", "json")
	}

	out, err := runKubectl(ctx, headers, cmdArgs...)
	if err != nil {
		return explainFailure(ctx, headers, err, resourceType, resourceName, namespace)
	}
	return out, nil
}

func handleGetResourceYAML(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}

	namespace := argString(args, "namespace", "")
	cmdArgs := []string{"get", resourceType, resourceName, "-o", "yaml"}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}

	out, err := runKubectl(ctx, headers, cmdArgs...)
	if err != nil {
		return explainFailure(ctx, headers, err, resourceType, resourceName, namespace)
	}
	return out, nil
}

func handleDescribeResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}

	namespace := argString(args, "namespace", "")
	cmdArgs := []string{"describe", resourceType, resourceName}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}

	out, err := runKubectl(ctx, headers, cmdArgs...)
	if err != nil {
		return explainFailure(ctx, headers, err, resourceType, resourceName, namespace)
	}
	return out, nil
}

func handleGetPodLogs(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	podName := argString(args, "pod_name", "")
	if podName == "" {
		return "", wrapBadRequest("pod_name parameter is required")
	}

	namespace := argString(args, "namespace", "default")
	container := argString(args, "container", "")
	// tail_lines is clamped to [1, maxLogTailLines]: a non-positive value
	// would mean "the whole log" and the model-supplied number is untrusted.
	tailLines := argInt(args, "tail_lines", 50)
	if tailLines <= 0 {
		tailLines = 50
	}
	if tailLines > maxLogTailLines {
		tailLines = maxLogTailLines
	}

	previous := argBool(args, "previous")
	since := argString(args, "since", "")
	allContainers := argBool(args, "all_containers")
	grep := strings.TrimSpace(argString(args, "grep", ""))

	cmdArgs := []string{"logs", podName, "-n", namespace}
	if allContainers {
		cmdArgs = append(cmdArgs, "--all-containers=true", "--prefix")
	} else if container != "" {
		cmdArgs = append(cmdArgs, "-c", container)
	}
	if previous {
		cmdArgs = append(cmdArgs, "--previous")
	}
	if since != "" {
		cmdArgs = append(cmdArgs, "--since="+since)
	}
	// A filter scans the whole tail window and keeps tail_lines matches.
	scan := tailLines
	if grep != "" {
		scan = maxLogTailLines
	}
	cmdArgs = append(cmdArgs, "--tail", fmt.Sprintf("%d", scan), "--limit-bytes", fmt.Sprintf("%d", outputMaxBytes))

	out, err := runKubectl(ctx, headers, cmdArgs...)
	if err != nil {
		return explainFailure(ctx, headers, err, "pods", podName, namespace)
	}
	if grep != "" {
		return grepLines(out, grep, tailLines), nil
	}
	return out, nil
}

// grepLines keeps the last limit lines containing pattern (case-insensitive
// substring) and says how many of the scanned lines matched.
func grepLines(text, pattern string, limit int) string {
	needle := strings.ToLower(pattern)
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	var hits []string
	for _, line := range lines {
		if strings.Contains(strings.ToLower(line), needle) {
			hits = append(hits, line)
		}
	}
	total := len(hits)
	if len(hits) > limit {
		hits = hits[len(hits)-limit:]
	}
	header := fmt.Sprintf("# grep %q: %d of %d lines matched", pattern, total, len(lines))
	if total > limit {
		header += fmt.Sprintf(", showing the last %d", limit)
	}
	if total == 0 {
		return header
	}
	return header + "\n" + strings.Join(hits, "\n")
}

func handleGetEvents(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	allNamespaces := argBool(args, "all_namespaces")

	var selectors []string
	if fs := strings.TrimSpace(argString(args, "field_selector", "")); fs != "" {
		selectors = append(selectors, fs)
	}
	if kind := argString(args, "kind", ""); kind != "" {
		selectors = append(selectors, "involvedObject.kind="+eventKindName(kind))
	}
	if name := argString(args, "name", ""); name != "" {
		selectors = append(selectors, "involvedObject.name="+name)
	}

	cmdArgs := []string{"get", "events", "-o", "json"}
	if namespace != "" && !allNamespaces {
		cmdArgs = append(cmdArgs, "-n", namespace)
	} else {
		cmdArgs = append(cmdArgs, "--all-namespaces")
	}
	if len(selectors) > 0 {
		cmdArgs = append(cmdArgs, "--field-selector="+strings.Join(selectors, ","))
	}

	output, err := runKubectl(ctx, headers, cmdArgs...)
	if err != nil {
		return explainFailure(ctx, headers, err, "events", "", namespace)
	}
	events := parseEvents(output)
	return marshalJSON(events)
}

// eventKindName turns what the model wrote (pods, deployment, Pod) into the
// involvedObject.kind the API stores (Pod, Deployment).
func eventKindName(kind string) string {
	known := map[string]string{
		"pod": "Pod", "deployment": "Deployment", "replicaset": "ReplicaSet", "statefulset": "StatefulSet",
		"daemonset": "DaemonSet", "job": "Job", "cronjob": "CronJob", "service": "Service", "node": "Node",
		"ingress": "Ingress", "configmap": "ConfigMap", "secret": "Secret", "namespace": "Namespace",
		"persistentvolumeclaim": "PersistentVolumeClaim", "pvc": "PersistentVolumeClaim",
		"persistentvolume": "PersistentVolume", "pv": "PersistentVolume",
		"horizontalpodautoscaler": "HorizontalPodAutoscaler", "hpa": "HorizontalPodAutoscaler",
		"endpointslice": "EndpointSlice", "poddisruptionbudget": "PodDisruptionBudget", "pdb": "PodDisruptionBudget",
	}
	lower := strings.ToLower(kind)
	for _, candidate := range []string{lower, strings.TrimSuffix(lower, "s"), strings.TrimSuffix(lower, "es")} {
		if v, ok := known[candidate]; ok {
			return v
		}
	}
	return kind
}

func handleGetAvailableAPIResources(ctx context.Context, _ map[string]interface{}, headers http.Header) (string, error) {
	output, err := runKubectl(ctx, headers, "api-resources")
	if err != nil {
		return "", err
	}
	resources := parseAPIResources(output)
	return marshalJSON(resources)
}

func handleGetClusterConfiguration(ctx context.Context, _ map[string]interface{}, headers http.Header) (string, error) {
	return runKubectl(ctx, headers, "config", "view", "-o", "json")
}

func handleGetClusterOverview(ctx context.Context, _ map[string]interface{}, headers http.Header) (string, error) {
	namespaces, err := countKubectlItems(ctx, headers, "get", "namespaces", "-o", "json")
	if err != nil {
		return "", err
	}
	podsOutput, err := runKubectl(ctx, headers, "get", "pods", "--all-namespaces", "-o", "json")
	if err != nil {
		return "", err
	}
	podCounts, podTotal := summarizePodStatus(podsOutput)

	services, err := countKubectlItems(ctx, headers, "get", "services", "--all-namespaces", "-o", "json")
	if err != nil {
		return "", err
	}
	deployments, err := countKubectlItems(ctx, headers, "get", "deployments", "--all-namespaces", "-o", "json")
	if err != nil {
		return "", err
	}
	pvcs, err := countKubectlItems(ctx, headers, "get", "pvc", "--all-namespaces", "-o", "json")
	if err != nil {
		return "", err
	}
	pvs, err := countKubectlItems(ctx, headers, "get", "pv", "-o", "json")
	if err != nil {
		return "", err
	}
	nodes, err := countKubectlItems(ctx, headers, "get", "nodes", "-o", "json")
	if err != nil {
		return "", err
	}

	versionOutput, err := runKubectl(ctx, headers, "version", "-o", "json")
	if err != nil {
		return "", err
	}
	clusterVersion := parseClusterVersion(versionOutput)

	result := map[string]interface{}{
		"total_namespaces":  namespaces,
		"total_pods":        podTotal,
		"total_services":    services,
		"total_deployments": deployments,
		"total_pvcs":        pvcs,
		"total_pvs":         pvs,
		"pod_status":        podCounts,
		"node_count":        nodes,
		"cluster_version":   clusterVersion,
	}
	return marshalJSON(result)
}

func handleGetNodeMetrics(ctx context.Context, _ map[string]interface{}, headers http.Header) (string, error) {
	output, err := runKubectl(ctx, headers, "top", "nodes", "--no-headers")
	if err != nil {
		return explainFailure(ctx, headers, err, "", "", "")
	}
	metrics := parseTopNodes(output)
	return marshalJSON(metrics)
}

func handleGetPodMetrics(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")
	cmdArgs := []string{"top", "pods", "--no-headers"}
	allNamespaces := true
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
		allNamespaces = false
	} else {
		cmdArgs = append(cmdArgs, "--all-namespaces")
	}
	output, err := runKubectl(ctx, headers, cmdArgs...)
	if err != nil {
		return explainFailure(ctx, headers, err, "", "", namespace)
	}
	metrics := parseTopPods(output, allNamespaces)
	return marshalJSON(metrics)
}

func handleCheckServiceConnectivity(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	serviceName := argString(args, "service_name", "")
	if serviceName == "" {
		serviceName = argString(args, "name", "")
	}
	if serviceName == "" {
		serviceName = argString(args, "service", "")
	}
	if serviceName == "" {
		return "", wrapBadRequest("service_name parameter is required")
	}

	namespace := argString(args, "namespace", "")
	if namespace == "" {
		return "", wrapBadRequest("namespace parameter is required")
	}
	requestedPort := argString(args, "port", "")

	svcOutput, err := runKubectl(ctx, headers, "get", "svc", serviceName, "-n", namespace, "-o", "json")
	if err != nil {
		result := map[string]interface{}{
			"namespace":  namespace,
			"service":    serviceName,
			"type":       "",
			"ports":      []map[string]interface{}{},
			"port_check": map[string]interface{}{},
			"endpoints": map[string]interface{}{
				"ready":     0,
				"not_ready": 0,
				"total":     0,
			},
			"status": "NotFound",
			"error":  err.Error(),
		}
		if requestedPort != "" {
			result["port_check"] = map[string]interface{}{"requested": requestedPort}
		}
		if f, ok := classifyKubectlFailure(err); ok && f.Status == "not_found" {
			result["namespace_exists"] = namespaceExists(ctx, headers, namespace)
			candidates, scope, _ := listNames(ctx, headers, "services", scopedNamespaces(ctx))
			result["similar"] = similarNames(serviceName, candidates)
			result["searched"] = scope
		}
		return marshalJSON(result)
	}
	serviceInfo, ports := parseServiceInfo(svcOutput)

	slicesOutput, err := runKubectl(ctx, headers, "get", "endpointslices", "-n", namespace, "-l", "kubernetes.io/service-name="+serviceName, "-o", "json")
	readyCount := 0
	notReadyCount := 0
	if err == nil {
		readyCount, notReadyCount = parseEndpointSlices(slicesOutput)
	}

	portCheck := map[string]interface{}{}
	if requestedPort != "" {
		portCheck["requested"] = requestedPort
		if matched := findMatchingPort(ports, requestedPort); matched != nil {
			portCheck["matched"] = matched
		}
	}

	status := "NotReady"
	if readyCount > 0 {
		status = "Ready"
	}

	result := map[string]interface{}{
		"namespace":  namespace,
		"service":    serviceName,
		"type":       serviceInfo.Type,
		"ports":      ports,
		"port_check": portCheck,
		"endpoints": map[string]interface{}{
			"ready":     readyCount,
			"not_ready": notReadyCount,
			"total":     readyCount + notReadyCount,
		},
		"status": status,
	}

	return marshalJSON(result)
}
