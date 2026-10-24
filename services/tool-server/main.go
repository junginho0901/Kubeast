package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/internalauth"
	"github.com/junginho0901/kubeast/services/pkg/metrics"
)

type ToolHandler func(ctx context.Context, args map[string]interface{}, headers http.Header) (string, error)

type ToolDefinition struct {
	Name        string
	Description string
	Handler     ToolHandler
}

var (
	kubeconfigPath = resolveKubeconfigPath()
	// Act as the JWT's user toward the cluster (--as/--as-group). The former
	// TOKEN_PASSTHROUGH (kubectl --token with the Kubeast JWT) is gone: clusters
	// never knew that token, so it either failed or was overridden.
	impersonationEnabled = !strings.EqualFold(os.Getenv("IMPERSONATION_ENABLED"), "false")
	// Write tools need the user's approval id (set by ai-service's approve path).
	writeApprovalRequired = !strings.EqualFold(os.Getenv("AI_WRITE_APPROVAL"), "false")
	defaultTimeout        = 60 * time.Second

	// toolAuth validates the caller's JWT against auth-service's JWKS (same
	// issuer/audience settings every other service uses).
	toolAuth tokenValidator = auth.NewJWTValidator(auth.JWKSConfig{
		JWKSURL:         envOrDefault("AUTH_JWKS_URL", "http://auth-service:8004/api/v1/auth/jwks.json"),
		Issuer:          envOrDefault("JWT_ISSUER", "kubeast-auth"),
		Audience:        envOrDefault("JWT_AUDIENCE", "kubeast"),
		TokenVersionURL: envOrDefault("AUTH_TOKEN_VERSION_URL", "http://auth-service:8004/api/v1/auth/internal/token-version"),
	})
)

func main() {
	port := envOrDefault("PORT", "8086")

	toolRegistry := buildToolRegistry()

	// kubectl reaches clusters through a loopback proxy that lists each request
	// with its Audit-ID (kubeproxy.go); TOOL_SERVER_KUBECTL_PROXY=false or a
	// failed start keeps the direct path.
	if !strings.EqualFold(os.Getenv("TOOL_SERVER_KUBECTL_PROXY"), "false") {
		if p, err := startKubeProxy(); err != nil {
			log.Printf("kubectl proxy not started, kubectl goes to clusters directly: %v", err)
		} else {
			kubectlProxy = p
		}
	}

	// Console metrics (services/pkg/metrics): the four fixed paths by name.
	m := metrics.New("tool-server")
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.Handle("/metrics", m.Handler())
	mux.HandleFunc("/tools/list", func(w http.ResponseWriter, r *http.Request) {
		handleList(w, r, toolRegistry)
	})
	mux.HandleFunc("/tools/call", func(w http.ResponseWriter, r *http.Request) {
		handleCall(w, r, toolRegistry)
	})
	// Internal: drop a cluster's cached kubeconfig (called by auth-service after a
	// kubeconfig rotation or a cluster delete). Cluster-network only.
	mux.Handle("/internal/invalidate", invalidateHandler(os.Getenv(internalauth.Env)))

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      m.Middleware(mux),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("tool-server listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	// On SIGTERM a rollout lets the tool calls in flight finish (within the pod's grace period) instead of cutting them.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
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
		Name:        "k8s_find_resource",
		Description: "Find resources by a name fragment or label across kinds and namespaces",
		Handler:     handleFindResource,
	})
	register(ToolDefinition{
		Name:        "k8s_explain",
		Description: "Explain a resource type or field (kubectl explain)",
		Handler:     handleExplain,
	})
	register(ToolDefinition{
		Name:        "prometheus_query",
		Description: "Run PromQL against the cluster's Prometheus through Kubeast (instant or range)",
		Handler:     handlePrometheusQuery,
	})
	register(ToolDefinition{
		Name:        "prometheus_metrics",
		Description: "Find metric names in the cluster's Prometheus, with type and help text",
		Handler:     handlePrometheusMetrics,
	})
	register(ToolDefinition{
		Name:        "prometheus_labels",
		Description: "Label names on the series a selector matches, or the values of one label",
		Handler:     handlePrometheusLabels,
	})
	register(ToolDefinition{
		Name:        "prometheus_rules",
		Description: "Alerting and recording rules of the cluster's Prometheus, with state and active alerts",
		Handler:     handlePrometheusRules,
	})
	register(ToolDefinition{
		Name:        "prometheus_targets",
		Description: "Scrape targets of the cluster's Prometheus and their health",
		Handler:     handlePrometheusTargets,
	})
	register(ToolDefinition{
		Name:        "alerts_list",
		Description: "The cluster's alerts in its alert store (Alertmanager): firing, silenced or inhibited, with the silences on them",
		Handler:     handleAlertsList,
	})
	register(ToolDefinition{
		Name:        "logsearch",
		Description: "Search the cluster's log store (Loki) through Kubeast — also pods that no longer exist",
		Handler:     handleLogSearch,
	})
	register(ToolDefinition{
		Name:        "loki_query",
		Description: "LogQL on the cluster's log store: newest lines, or series for a metric query (count_over_time, rate)",
		Handler:     handleLokiQuery,
	})
	register(ToolDefinition{
		Name:        "loki_labels",
		Description: "Label names, or one label's values, on the cluster's log streams",
		Handler:     handleLokiLabels,
	})
	register(ToolDefinition{
		Name:        "loki_patterns",
		Description: "Log patterns of the selected streams (Loki's pattern ingester), most lines first",
		Handler:     handleLokiPatterns,
	})
	register(ToolDefinition{
		Name:        "traces_search",
		Description: "TraceQL search on the cluster's trace store (Tempo): the newest matching traces and the spans that matched",
		Handler:     handleTracesSearch,
	})
	register(ToolDefinition{
		Name:        "traces_get",
		Description: "One trace by ID: its spans in your cluster and namespace, errors first",
		Handler:     handleTracesGet,
	})
	register(ToolDefinition{
		Name:        "traces_tags",
		Description: "Span attribute names by scope, or one attribute's values, on the cluster's traces",
		Handler:     handleTracesTags,
	})
	register(ToolDefinition{
		Name:        "traces_metrics",
		Description: "TraceQL metrics (rate, error rate, latency quantiles) over time, as series",
		Handler:     handleTracesMetrics,
	})
	register(ToolDefinition{
		Name:        "traces_compare",
		Description: "Fastest, typical and slowest matching traces with p50/p90",
		Handler:     handleTracesCompare,
	})
	register(ToolDefinition{
		Name:        "issues",
		Description: "Kubeast's issue check: failing pods, workloads, nodes, PVCs and Warning events in one pass",
		Handler:     handleIssues,
	})
	register(ToolDefinition{
		Name:        "hygiene",
		Description: "The cluster hygiene report (Pod Security, image tags, TLS expiry, upgrade readiness) — Admin",
		Handler:     handleHygiene,
	})
	register(ToolDefinition{
		Name:        "gitops_status",
		Description: "Argo CD Applications in this cluster: sync, health, last operation, error conditions, out-of-sync resources",
		Handler:     handleGitopsStatus,
	})
	register(ToolDefinition{
		Name:        "audit_search",
		Description: "Kubeast audit log entries by action, actor, target, result and time — Admin",
		Handler:     handleAuditSearch,
	})
	register(ToolDefinition{
		Name:        "nodes_stats_summary",
		Description: "Kubelet stats summary of a node (cpu, memory, fs, network, PSI, top pods) — Admin",
		Handler:     handleNodesStatsSummary,
	})
	register(ToolDefinition{
		Name:        "nodes_log",
		Description: "Kubelet / system log lines of a node through the API server proxy — Admin",
		Handler:     handleNodesLog,
	})
	register(ToolDefinition{
		Name:        "policy_reports",
		Description: "PolicyReport / ClusterPolicyReport summary or result rows (Kyverno, Trivy Operator …)",
		Handler:     handlePolicyReports,
	})
	register(ToolDefinition{
		Name:        "helm_read",
		Description: "Helm releases read-only: list, detail, values, manifest, history, resources, images, revisions, diff",
		Handler:     handleHelmRead,
	})
	register(ToolDefinition{
		Name:        "cost",
		Description: "OpenCost allocation by namespace or controller for a window",
		Handler:     handleCost,
	})
	register(ToolDefinition{
		Name:        "optimization",
		Description: "Requests vs usage with a recommendation per container of one namespace",
		Handler:     handleOptimization,
	})
	register(ToolDefinition{
		Name:        "can_i",
		Description: "Whether the signed-in user may do a verb on a resource in this cluster (SelfSubjectAccessReview)",
		Handler:     handleCanI,
	})
	register(ToolDefinition{
		Name:        "network_policy_check",
		Description: "Whether Kubernetes NetworkPolicy allows a connection between pods, workloads, a Service or an address, and which policy and rule decide",
		Handler:     handleNetworkPolicyCheck,
	})
	register(ToolDefinition{
		Name:        "network_flows",
		Description: "Recent network flows of a namespace, pod or workload from the cluster's Hubble Relay: who talked to whom, forwarded or dropped and why",
		Handler:     handleNetworkFlows,
	})
	register(ToolDefinition{
		Name:        "resource_graph",
		Description: "The objects of one namespace and the edges between them, with counts by kind",
		Handler:     handleResourceGraph,
	})
	register(ToolDefinition{
		Name:        "k8s_jq_query",
		Description: "kubectl get -o json filtered by a jq expression (capped results)",
		Handler:     handleJQQuery,
	})
	register(ToolDefinition{
		Name:        "k8s_tabular_query",
		Description: "kubectl get as a custom-columns table, optionally sorted, capped rows",
		Handler:     handleTabularQuery,
	})
	register(ToolDefinition{
		Name:        "k8s_count",
		Description: "How many objects match, optionally grouped by a field",
		Handler:     handleCount,
	})
	register(ToolDefinition{
		Name:        "k8s_diff",
		Description: "Preview what a manifest would change: server dry run against the live object, nothing applied",
		Handler:     handleDiff,
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

// invalidateHandler answers POST /internal/invalidate?cluster= from a service
// holding the internal token (X-Internal-Token, like k8s-service's /internal).
func invalidateHandler(token string) http.Handler {
	return internalauth.Middleware(token)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		invalidateClusterKubeconfig(r.URL.Query().Get("cluster"))
		w.WriteHeader(http.StatusNoContent)
	}))
}
