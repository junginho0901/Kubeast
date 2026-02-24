package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type ToolCallRequest struct {
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments"`
}

type ToolCallResponse struct {
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

type ToolInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

type ToolListResponse struct {
	Tools []ToolInfo `json:"tools"`
}

type ToolHandler func(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error)

type ToolDefinition struct {
	Name        string
	Description string
	Handler     ToolHandler
}

var (
	kubeconfigPath   = resolveKubeconfigPath()
	tokenPassthrough = strings.EqualFold(os.Getenv("TOKEN_PASSTHROUGH"), "true")
	defaultTimeout   = 60 * time.Second
)

func main() {
	port := envOrDefault("PORT", "8086")

	toolRegistry := buildToolRegistry()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/tools/list", func(w http.ResponseWriter, r *http.Request) {
		handleList(w, r, toolRegistry)
	})
	mux.HandleFunc("/tools/call", func(w http.ResponseWriter, r *http.Request) {
		handleCall(w, r, toolRegistry)
	})

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("tool-server listening on :%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func handleList(w http.ResponseWriter, r *http.Request, tools map[string]ToolDefinition) {
	list := make([]ToolInfo, 0, len(tools))
	for _, tool := range tools {
		list = append(list, ToolInfo{Name: tool.Name, Description: tool.Description})
	}
	respondJSON(w, http.StatusOK, ToolListResponse{Tools: list})
}

func handleCall(w http.ResponseWriter, r *http.Request, tools map[string]ToolDefinition) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	decoder := json.NewDecoder(r.Body)
	decoder.UseNumber()

	var req ToolCallRequest
	if err := decoder.Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, ToolCallResponse{Error: "invalid json"})
		return
	}
	if req.Name == "" {
		respondJSON(w, http.StatusBadRequest, ToolCallResponse{Error: "name is required"})
		return
	}

	tool, ok := tools[req.Name]
	if !ok {
		respondJSON(w, http.StatusNotFound, ToolCallResponse{Error: "unknown tool"})
		return
	}
	log.Printf("tool call: %s", req.Name)

	ctx, cancel := context.WithTimeout(r.Context(), defaultTimeout)
	defer cancel()

	output, err := tool.Handler(ctx, req.Arguments, r.Header)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errBadRequest) {
			status = http.StatusBadRequest
		}
		respondJSON(w, status, ToolCallResponse{Error: err.Error()})
		return
	}

	respondJSON(w, http.StatusOK, ToolCallResponse{Content: output})
}

func buildToolRegistry() map[string]ToolDefinition {
	registry := map[string]ToolDefinition{}

	register := func(def ToolDefinition) {
		registry[def.Name] = def
	}

	register(ToolDefinition{
		Name:        "k8s_get_resources",
		Description: "Get Kubernetes resources using kubectl",
		Handler:     handleGetResources,
	})
	register(ToolDefinition{
		Name:        "k8s_get_resource_yaml",
		Description: "Get the YAML representation of a Kubernetes resource",
		Handler:     handleGetResourceYAML,
	})
	register(ToolDefinition{
		Name:        "k8s_describe_resource",
		Description: "Describe a Kubernetes resource in detail",
		Handler:     handleDescribeResource,
	})
	register(ToolDefinition{
		Name:        "k8s_get_pod_logs",
		Description: "Get logs from a Kubernetes pod",
		Handler:     handleGetPodLogs,
	})
	register(ToolDefinition{
		Name:        "k8s_get_events",
		Description: "Get events from a Kubernetes namespace",
		Handler:     handleGetEvents,
	})
	register(ToolDefinition{
		Name:        "k8s_get_available_api_resources",
		Description: "Get available Kubernetes API resources",
		Handler:     handleGetAvailableAPIResources,
	})
	register(ToolDefinition{
		Name:        "k8s_get_cluster_configuration",
		Description: "Get cluster configuration details",
		Handler:     handleGetClusterConfiguration,
	})
	register(ToolDefinition{
		Name:        "get_cluster_overview",
		Description: "Get an overview of cluster health and resource counts",
		Handler:     handleGetClusterOverview,
	})
	register(ToolDefinition{
		Name:        "get_node_metrics",
		Description: "Get node CPU/Memory usage (kubectl top nodes)",
		Handler:     handleGetNodeMetrics,
	})
	register(ToolDefinition{
		Name:        "get_pod_metrics",
		Description: "Get pod CPU/Memory usage (kubectl top pods)",
		Handler:     handleGetPodMetrics,
	})
	register(ToolDefinition{
		Name:        "k8s_check_service_connectivity",
		Description: "Check Service/Endpoint connectivity",
		Handler:     handleCheckServiceConnectivity,
	})
	register(ToolDefinition{
		Name:        "k8s_apply_manifest",
		Description: "Apply a Kubernetes manifest (kubectl apply -f -)",
		Handler:     handleApplyManifest,
	})
	register(ToolDefinition{
		Name:        "k8s_create_resource",
		Description: "Create a Kubernetes resource from manifest (kubectl create -f -)",
		Handler:     handleCreateResource,
	})
	register(ToolDefinition{
		Name:        "k8s_create_resource_from_url",
		Description: "Create resources from manifest URL (kubectl create -f URL)",
		Handler:     handleCreateResourceFromURL,
	})
	register(ToolDefinition{
		Name:        "k8s_delete_resource",
		Description: "Delete a Kubernetes resource (kubectl delete)",
		Handler:     handleDeleteResource,
	})
	register(ToolDefinition{
		Name:        "k8s_patch_resource",
		Description: "Patch a Kubernetes resource (kubectl patch)",
		Handler:     handlePatchResource,
	})
	register(ToolDefinition{
		Name:        "k8s_annotate_resource",
		Description: "Annotate a Kubernetes resource (kubectl annotate)",
		Handler:     handleAnnotateResource,
	})
	register(ToolDefinition{
		Name:        "k8s_remove_annotation",
		Description: "Remove annotations from a Kubernetes resource (kubectl annotate key-)",
		Handler:     handleRemoveAnnotation,
	})
	register(ToolDefinition{
		Name:        "k8s_label_resource",
		Description: "Label a Kubernetes resource (kubectl label)",
		Handler:     handleLabelResource,
	})
	register(ToolDefinition{
		Name:        "k8s_remove_label",
		Description: "Remove labels from a Kubernetes resource (kubectl label key-)",
		Handler:     handleRemoveLabel,
	})
	register(ToolDefinition{
		Name:        "k8s_scale",
		Description: "Scale a Kubernetes workload (kubectl scale)",
		Handler:     handleScaleResource,
	})
	register(ToolDefinition{
		Name:        "k8s_rollout",
		Description: "Rollout operations (restart/undo/pause/resume/status)",
		Handler:     handleRollout,
	})
	register(ToolDefinition{
		Name:        "k8s_execute_command",
		Description: "Execute a command inside a pod container (kubectl exec)",
		Handler:     handleExecuteCommand,
	})

	return registry
}

var errBadRequest = errors.New("bad request")

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
			"namespace": namespace,
			"service":   serviceName,
			"type":      "",
			"ports":     []map[string]interface{}{},
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
		"namespace": namespace,
		"service":   serviceName,
		"type":      serviceInfo.Type,
		"ports":     ports,
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

func handleApplyManifest(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	manifest, err := manifestFromArgs(args)
	if err != nil {
		return "", err
	}
	return runKubectlWithInput(ctx, headers, manifest, "apply", "-f", "-")
}

func handleCreateResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	manifest, err := manifestFromArgs(args)
	if err != nil {
		return "", err
	}
	return runKubectlWithInput(ctx, headers, manifest, "create", "-f", "-")
}

func handleCreateResourceFromURL(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	url := argString(args, "url", "")
	if url == "" {
		url = argString(args, "manifest_url", "")
	}
	if url == "" {
		return "", wrapBadRequest("url parameter is required")
	}
	return runKubectl(ctx, headers, "create", "-f", url)
}

func handleDeleteResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	if resourceType == "" {
		return "", wrapBadRequest("resource_type parameter is required")
	}
	resourceName := argString(args, "resource_name", "")
	all := argBool(args, "all")
	if resourceName == "" && !all {
		return "", wrapBadRequest("resource_name parameter is required unless all=true")
	}
	namespace := argString(args, "namespace", "")
	grace := argInt(args, "grace_period", -1)
	force := argBool(args, "force")
	wait := argBool(args, "wait")
	ignoreNotFound := argBool(args, "ignore_not_found")

	cmdArgs := []string{"delete", resourceType}
	if resourceName != "" {
		cmdArgs = append(cmdArgs, resourceName)
	}
	if all {
		cmdArgs = append(cmdArgs, "--all")
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if grace >= 0 {
		cmdArgs = append(cmdArgs, "--grace-period", strconv.Itoa(grace))
	}
	if force {
		cmdArgs = append(cmdArgs, "--force")
	}
	if wait {
		cmdArgs = append(cmdArgs, "--wait=true")
	}
	if ignoreNotFound {
		cmdArgs = append(cmdArgs, "--ignore-not-found=true")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handlePatchResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	patchContent, err := patchFromArgs(args)
	if err != nil {
		return "", err
	}
	namespace := argString(args, "namespace", "")
	patchType := argString(args, "patch_type", "")

	cmdArgs := []string{"patch", resourceType, resourceName, "-p", patchContent}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if patchType != "" {
		cmdArgs = append(cmdArgs, "--type", patchType)
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleAnnotateResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	annotations := argStringMap(args, "annotations")
	if len(annotations) == 0 {
		return "", wrapBadRequest("annotations parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"annotate", resourceType, resourceName}
	for k, v := range annotations {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s=%s", k, v))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleRemoveAnnotation(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	keys := argStringSlice(args, "keys")
	if len(keys) == 0 {
		return "", wrapBadRequest("keys parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"annotate", resourceType, resourceName}
	for _, k := range keys {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s-", k))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleLabelResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	labels := argStringMap(args, "labels")
	if len(labels) == 0 {
		return "", wrapBadRequest("labels parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"label", resourceType, resourceName}
	for k, v := range labels {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s=%s", k, v))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleRemoveLabel(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	keys := argStringSlice(args, "keys")
	if len(keys) == 0 {
		return "", wrapBadRequest("keys parameter is required")
	}
	namespace := argString(args, "namespace", "")
	overwrite := argBool(args, "overwrite")

	cmdArgs := []string{"label", resourceType, resourceName}
	for _, k := range keys {
		cmdArgs = append(cmdArgs, fmt.Sprintf("%s-", k))
	}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if overwrite {
		cmdArgs = append(cmdArgs, "--overwrite")
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleScaleResource(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	replicas := argInt(args, "replicas", -1)
	if replicas < 0 {
		return "", wrapBadRequest("replicas parameter is required")
	}
	namespace := argString(args, "namespace", "")

	cmdArgs := []string{"scale", resourceType, resourceName, "--replicas", strconv.Itoa(replicas)}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleRollout(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	action := argString(args, "action", "")
	if action == "" {
		return "", wrapBadRequest("action parameter is required")
	}
	resourceType := argString(args, "resource_type", "")
	resourceName := argString(args, "resource_name", "")
	if resourceType == "" || resourceName == "" {
		return "", wrapBadRequest("resource_type and resource_name are required")
	}
	namespace := argString(args, "namespace", "")
	revision := argInt(args, "revision", 0)
	timeout := argString(args, "timeout", "")

	cmdArgs := []string{"rollout", action, fmt.Sprintf("%s/%s", resourceType, resourceName)}
	if namespace != "" {
		cmdArgs = append(cmdArgs, "-n", namespace)
	}
	if revision > 0 {
		cmdArgs = append(cmdArgs, "--revision", strconv.Itoa(revision))
	}
	if timeout != "" {
		cmdArgs = append(cmdArgs, "--timeout", timeout)
	}
	return runKubectl(ctx, headers, cmdArgs...)
}

func handleExecuteCommand(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error) {
	podName := argString(args, "pod_name", "")
	if podName == "" {
		return "", wrapBadRequest("pod_name parameter is required")
	}
	namespace := argString(args, "namespace", "default")
	container := argString(args, "container", "")
	command := argStringSlice(args, "command")
	if len(command) == 0 {
		command = argStringSlice(args, "cmd")
	}
	if len(command) == 0 {
		return "", wrapBadRequest("command parameter is required")
	}

	cmdArgs := []string{"exec", podName, "-n", namespace}
	if container != "" {
		cmdArgs = append(cmdArgs, "-c", container)
	}
	cmdArgs = append(cmdArgs, "--")
	cmdArgs = append(cmdArgs, command...)
	return runKubectl(ctx, headers, cmdArgs...)
}

func runKubectl(ctx context.Context, headers http.Header, args ...string) (string, error) {
	token, err := tokenForKubectl(headers)
	if err != nil {
		return "", err
	}

	finalArgs := make([]string, 0, len(args)+4)
	if kubeconfigPath != "" {
		finalArgs = append(finalArgs, "--kubeconfig", kubeconfigPath)
	}
	if token != "" {
		finalArgs = append(finalArgs, "--token", token)
	}
	finalArgs = append(finalArgs, args...)

	cmd := exec.CommandContext(ctx, "kubectl", finalArgs...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		errText := strings.TrimSpace(string(output))
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("kubectl failed: %s", errText)
	}

	return string(output), nil
}

func runKubectlWithInput(ctx context.Context, headers http.Header, input string, args ...string) (string, error) {
	token, err := tokenForKubectl(headers)
	if err != nil {
		return "", err
	}

	finalArgs := make([]string, 0, len(args)+4)
	if kubeconfigPath != "" {
		finalArgs = append(finalArgs, "--kubeconfig", kubeconfigPath)
	}
	if token != "" {
		finalArgs = append(finalArgs, "--token", token)
	}
	finalArgs = append(finalArgs, args...)

	cmd := exec.CommandContext(ctx, "kubectl", finalArgs...)
	cmd.Stdin = strings.NewReader(input)
	output, err := cmd.CombinedOutput()
	if err != nil {
		errText := strings.TrimSpace(string(output))
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("kubectl failed: %s", errText)
	}
	return string(output), nil
}

func tokenForKubectl(headers http.Header) (string, error) {
	token := extractBearerToken(headers)
	if tokenPassthrough && token == "" {
		return "", wrapBadRequest("Bearer token required when TOKEN_PASSTHROUGH is true")
	}
	if tokenPassthrough {
		return token, nil
	}
	return "", nil
}

func extractBearerToken(headers http.Header) string {
	auth := headers.Get("Authorization")
	if auth == "" {
		return ""
	}
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) != 2 {
		return ""
	}
	if strings.ToLower(parts[0]) != "bearer" {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func resolveKubeconfigPath() string {
	if strings.EqualFold(os.Getenv("TOOL_SERVER_USE_INCLUSTER"), "true") {
		return ""
	}
	if v := os.Getenv("TOOL_SERVER_KUBECONFIG_PATH"); v != "" {
		return v
	}
	if v := os.Getenv("KUBECONFIG_PATH"); v != "" {
		return v
	}
	if v := os.Getenv("KUBECONFIG"); v != "" {
		return v
	}
	return ""
}

func argString(args map[string]interface{}, key, def string) string {
	if args == nil {
		return def
	}
	val, ok := args[key]
	if !ok || val == nil {
		return def
	}
	switch v := val.(type) {
	case string:
		if v == "" {
			return def
		}
		return v
	default:
		return fmt.Sprint(v)
	}
}

func argBool(args map[string]interface{}, key string) bool {
	if args == nil {
		return false
	}
	val, ok := args[key]
	if !ok || val == nil {
		return false
	}
	switch v := val.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true")
	case json.Number:
		return v.String() == "1"
	case float64:
		return v != 0
	case int:
		return v != 0
	default:
		return false
	}
}

func argInt(args map[string]interface{}, key string, def int) int {
	if args == nil {
		return def
	}
	val, ok := args[key]
	if !ok || val == nil {
		return def
	}
	switch v := val.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		i, err := strconv.Atoi(v.String())
		if err != nil {
			return def
		}
		return i
	case string:
		i, err := strconv.Atoi(v)
		if err != nil {
			return def
		}
		return i
	default:
		return def
	}
}

func argStringSlice(args map[string]interface{}, key string) []string {
	if args == nil {
		return nil
	}
	val, ok := args[key]
	if !ok || val == nil {
		return nil
	}
	switch v := val.(type) {
	case []string:
		return v
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if item == nil {
				continue
			}
			s := strings.TrimSpace(fmt.Sprint(item))
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		raw := strings.TrimSpace(v)
		if raw == "" {
			return nil
		}
		parts := strings.Split(raw, ",")
		if len(parts) == 1 {
			return strings.Fields(raw)
		}
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			s := strings.TrimSpace(p)
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func argStringMap(args map[string]interface{}, key string) map[string]string {
	if args == nil {
		return nil
	}
	val, ok := args[key]
	if !ok || val == nil {
		return nil
	}
	switch v := val.(type) {
	case map[string]string:
		return v
	case map[string]interface{}:
		out := make(map[string]string, len(v))
		for k, raw := range v {
			if k == "" || raw == nil {
				continue
			}
			out[k] = fmt.Sprint(raw)
		}
		return out
	default:
		return nil
	}
}

func manifestFromArgs(args map[string]interface{}) (string, error) {
	if args == nil {
		return "", wrapBadRequest("resource_manifest or yaml_content is required")
	}
	if v, ok := args["yaml_content"]; ok && v != nil {
		raw := strings.TrimSpace(fmt.Sprint(v))
		if raw != "" {
			return raw, nil
		}
	}
	if v, ok := args["manifest"]; ok && v != nil {
		raw := strings.TrimSpace(fmt.Sprint(v))
		if raw != "" {
			return raw, nil
		}
	}
	if v, ok := args["resource_manifest"]; ok && v != nil {
		switch typed := v.(type) {
		case string:
			raw := strings.TrimSpace(typed)
			if raw != "" {
				return raw, nil
			}
		default:
			data, err := json.Marshal(typed)
			if err != nil {
				return "", err
			}
			return string(data), nil
		}
	}
	return "", wrapBadRequest("resource_manifest or yaml_content is required")
}

func patchFromArgs(args map[string]interface{}) (string, error) {
	if args == nil {
		return "", wrapBadRequest("patch parameter is required")
	}
	for _, key := range []string{"patch", "patch_content", "patch_body"} {
		if v, ok := args[key]; ok && v != nil {
			switch typed := v.(type) {
			case string:
				raw := strings.TrimSpace(typed)
				if raw == "" {
					break
				}
				return raw, nil
			default:
				data, err := json.Marshal(typed)
				if err != nil {
					return "", err
				}
				return string(data), nil
			}
		}
	}
	return "", wrapBadRequest("patch parameter is required")
}

type listItems struct {
	Items []json.RawMessage `json:"items"`
}

type podList struct {
	Items []struct {
		Status struct {
			Phase string `json:"phase"`
		} `json:"status"`
	} `json:"items"`
}

type versionInfo struct {
	ServerVersion struct {
		GitVersion string `json:"gitVersion"`
	} `json:"serverVersion"`
}

type serviceInfo struct {
	Type string `json:"type"`
}

type servicePort struct {
	Name     string `json:"name,omitempty"`
	Port     int    `json:"port,omitempty"`
	Protocol string `json:"protocol,omitempty"`
}

type serviceMeta struct {
	Name      string `json:"name,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

type serviceResource struct {
	Metadata serviceMeta `json:"metadata"`
	Spec     struct {
		Type  string        `json:"type"`
		Ports []servicePort `json:"ports"`
	} `json:"spec"`
}

type endpointResource struct {
	Subsets []struct {
		Addresses         []map[string]interface{} `json:"addresses"`
		NotReadyAddresses []map[string]interface{} `json:"notReadyAddresses"`
	} `json:"subsets"`
}

type eventList struct {
	Items []eventItem `json:"items"`
}

type eventItem struct {
	Type           string `json:"type"`
	Reason         string `json:"reason"`
	Message        string `json:"message"`
	FirstTimestamp string `json:"firstTimestamp"`
	LastTimestamp  string `json:"lastTimestamp"`
	EventTime      string `json:"eventTime"`
	Count          int    `json:"count"`
	Series         *struct {
		Count            int    `json:"count"`
		LastObservedTime string `json:"lastObservedTime"`
	} `json:"series"`
	Metadata struct {
		Namespace string `json:"namespace"`
	} `json:"metadata"`
	InvolvedObject struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
	} `json:"involvedObject"`
}

func countKubectlItems(ctx context.Context, headers http.Header, args ...string) (int, error) {
	output, err := runKubectl(ctx, headers, args...)
	if err != nil {
		return 0, err
	}
	var list listItems
	if err := json.Unmarshal([]byte(output), &list); err != nil {
		return 0, err
	}
	return len(list.Items), nil
}

func summarizePodStatus(output string) (map[string]int, int) {
	counts := make(map[string]int)
	var list podList
	if err := json.Unmarshal([]byte(output), &list); err != nil {
		return counts, 0
	}
	total := 0
	for _, item := range list.Items {
		phase := strings.TrimSpace(item.Status.Phase)
		if phase == "" {
			phase = "Unknown"
		}
		counts[phase]++
		total++
	}
	return counts, total
}

func parseClusterVersion(output string) string {
	var info versionInfo
	if err := json.Unmarshal([]byte(output), &info); err != nil {
		return ""
	}
	return info.ServerVersion.GitVersion
}

func parseServiceInfo(output string) (serviceInfo, []map[string]interface{}) {
	var svc serviceResource
	if err := json.Unmarshal([]byte(output), &svc); err != nil {
		return serviceInfo{}, nil
	}
	info := serviceInfo{Type: svc.Spec.Type}
	ports := make([]map[string]interface{}, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		ports = append(ports, map[string]interface{}{
			"name":     p.Name,
			"port":     p.Port,
			"protocol": p.Protocol,
		})
	}
	return info, ports
}

func parseEndpoints(output string) (int, int) {
	var eps endpointResource
	if err := json.Unmarshal([]byte(output), &eps); err != nil {
		return 0, 0
	}
	ready := 0
	notReady := 0
	for _, subset := range eps.Subsets {
		ready += len(subset.Addresses)
		notReady += len(subset.NotReadyAddresses)
	}
	return ready, notReady
}

func findMatchingPort(ports []map[string]interface{}, requested string) map[string]interface{} {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return nil
	}
	for _, p := range ports {
		name, _ := p["name"].(string)
		portVal := fmt.Sprint(p["port"])
		if requested == name || requested == portVal {
			return p
		}
	}
	return nil
}

func parseTopNodes(output string) []map[string]interface{} {
	lines := strings.Split(output, "\n")
	results := make([]map[string]interface{}, 0)
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		name := fields[0]
		cpu := fields[1]
		rest := fields[2:]
		metric := map[string]interface{}{
			"name": name,
			"cpu":  cpu,
		}
		applyUsageFields(metric, rest)
		results = append(results, metric)
	}
	return results
}

func parseTopPods(output string, allNamespaces bool) []map[string]interface{} {
	lines := strings.Split(output, "\n")
	results := make([]map[string]interface{}, 0)
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		idx := 0
		metric := map[string]interface{}{}
		if allNamespaces {
			if len(fields) < 4 {
				continue
			}
			metric["namespace"] = fields[0]
			idx++
		}
		metric["name"] = fields[idx]
		idx++
		metric["cpu"] = fields[idx]
		idx++
		rest := fields[idx:]
		applyUsageFields(metric, rest)
		results = append(results, metric)
	}
	return results
}

func applyUsageFields(metric map[string]interface{}, fields []string) {
	if len(fields) == 0 {
		return
	}
	if len(fields) == 1 {
		metric["memory"] = fields[0]
		return
	}
	if len(fields) == 2 {
		if strings.HasSuffix(fields[0], "%") && !strings.HasSuffix(fields[1], "%") {
			metric["cpu_percent"] = fields[0]
			metric["memory"] = fields[1]
			return
		}
		if !strings.HasSuffix(fields[0], "%") && strings.HasSuffix(fields[1], "%") {
			metric["memory"] = fields[0]
			metric["memory_percent"] = fields[1]
			return
		}
		metric["memory"] = fields[1]
		return
	}
	metric["cpu_percent"] = fields[0]
	metric["memory"] = fields[1]
	metric["memory_percent"] = fields[2]
}

func parseEvents(output string) []map[string]interface{} {
	var list eventList
	if err := json.Unmarshal([]byte(output), &list); err != nil {
		return nil
	}
	results := make([]map[string]interface{}, 0, len(list.Items))
	for _, ev := range list.Items {
		first := ev.FirstTimestamp
		last := ev.LastTimestamp
		if last == "" {
			if ev.EventTime != "" {
				last = ev.EventTime
			} else if ev.Series != nil && ev.Series.LastObservedTime != "" {
				last = ev.Series.LastObservedTime
			}
		}
		if first == "" {
			if ev.EventTime != "" {
				first = ev.EventTime
			} else if ev.Series != nil && ev.Series.LastObservedTime != "" {
				first = ev.Series.LastObservedTime
			}
		}
		count := ev.Count
		if count == 0 && ev.Series != nil {
			count = ev.Series.Count
		}
		results = append(results, map[string]interface{}{
			"type":            ev.Type,
			"reason":          ev.Reason,
			"message":         ev.Message,
			"namespace":       ev.Metadata.Namespace,
			"object":          map[string]interface{}{"kind": ev.InvolvedObject.Kind, "name": ev.InvolvedObject.Name},
			"first_timestamp": first,
			"last_timestamp":  last,
			"count":           count,
		})
	}
	return results
}

func parseAPIResources(output string) []map[string]interface{} {
	lines := strings.Split(output, "\n")
	results := make([]map[string]interface{}, 0)
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if i == 0 && strings.HasPrefix(strings.ToUpper(line), "NAME") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		name := fields[0]
		short := ""
		apiVersion := ""
		namespaced := ""
		kind := ""
		if len(fields) == 4 {
			apiVersion = fields[1]
			namespaced = fields[2]
			kind = fields[3]
		} else {
			short = fields[1]
			apiVersion = fields[2]
			namespaced = fields[3]
			kind = fields[4]
		}
		shortNames := []string{}
		if short != "" && short != "<none>" {
			shortNames = strings.Split(short, ",")
		}
		results = append(results, map[string]interface{}{
			"name":       name,
			"shortNames": shortNames,
			"apiVersion": apiVersion,
			"namespaced": strings.EqualFold(namespaced, "true"),
			"kind":       kind,
		})
	}
	return results
}

func marshalJSON(value interface{}) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func wrapBadRequest(message string) error {
	return fmt.Errorf("%w: %s", errBadRequest, message)
}

func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
