// Read tool handler 모음. main.go 에서 추출 (Phase 3.6.f).
//
// 11개 read 도구: get_resources / get_resource_yaml / describe / pod_logs /
// get_events / get_available_api_resources / get_cluster_configuration /
// get_cluster_overview / get_node_metrics / get_pod_metrics /
// check_service_connectivity. 모두 args 파서 + runKubectl + parse 헬퍼만 사용.

package main

import (
	"context"
	"fmt"
	"net/http"
)

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

	return runKubectl(ctx, headers, cmdArgs...)
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

	return runKubectl(ctx, headers, cmdArgs...)
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

	return runKubectl(ctx, headers, cmdArgs...)
}

func handleGetPodLogs(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	podName := argString(args, "pod_name", "")
	if podName == "" {
		return "", wrapBadRequest("pod_name parameter is required")
	}

	namespace := argString(args, "namespace", "default")
	container := argString(args, "container", "")
	tailLines := argInt(args, "tail_lines", 50)

	cmdArgs := []string{"logs", podName, "-n", namespace}
	if container != "" {
		cmdArgs = append(cmdArgs, "-c", container)
	}
	if tailLines > 0 {
		cmdArgs = append(cmdArgs, "--tail", fmt.Sprintf("%d", tailLines))
	}

	return runKubectl(ctx, headers, cmdArgs...)
}

func handleGetEvents(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	namespace := argString(args, "namespace", "")

	cmdArgs := []string{"get", "events", "-o", "json"}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	} else {
		cmdArgs = append(cmdArgs, "--all-namespaces")
	}

	output, err := runKubectl(ctx, headers, cmdArgs...)
	if err != nil {
		return "", err
	}
	events := parseEvents(output)
	return marshalJSON(events)
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
		return "", err
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
		return "", err
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
		return marshalJSON(result)
	}
	serviceInfo, ports := parseServiceInfo(svcOutput)

	endpointsOutput, err := runKubectl(ctx, headers, "get", "endpoints", serviceName, "-n", namespace, "-o", "json")
	readyCount := 0
	notReadyCount := 0
	if err != nil {
		readyCount = 0
		notReadyCount = 0
	} else {
		readyCount, notReadyCount = parseEndpoints(endpointsOutput)
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
