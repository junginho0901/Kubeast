package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

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
	// Internal: drop a cluster's cached kubeconfig (called by auth-service after a
	// kubeconfig rotation). Cluster-network only; just a cache-bust, no K8s access.
	mux.HandleFunc("/internal/invalidate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		invalidateClusterKubeconfig(r.URL.Query().Get("cluster"))
		w.WriteHeader(http.StatusNoContent)
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

