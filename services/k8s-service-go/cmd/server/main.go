package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kube-assistant/services/k8s-service-go/internal/ws"
	"github.com/junginho0901/kube-assistant/services/pkg/auth"
	"github.com/junginho0901/kube-assistant/services/pkg/logger"
)

func main() {
	// Load configuration
	cfg := config.Load()

	// Setup structured logger
	logger.Setup(cfg.AppName, cfg.Debug)

	slog.Info("starting k8s-service-go", "port", cfg.Port, "debug", cfg.Debug)

	// Init Redis cache
	redisCache := cache.New(cfg.RedisHost, cfg.RedisPort, cfg.RedisDB)

	// Init Kubernetes service
	k8sSvc, err := k8s.NewService(cfg.KubeconfigPath, cfg.InCluster, redisCache)
	if err != nil {
		slog.Error("failed to initialize k8s service", "err", err)
		os.Exit(1)
	}

	// Init JWT validator
	jwtValidator := auth.NewJWTValidator(auth.JWKSConfig{
		JWKSURL:  cfg.AuthJWKSURL,
		Issuer:   cfg.JWTIssuer,
		Audience: cfg.JWTAudience,
	})

	// Init handler
	h := handler.New(k8sSvc, cfg)

	// Init WebSocket multiplexer
	wsMux := ws.NewMultiplexer(k8sSvc.Clientset(), k8sSvc.Dynamic())

	// Setup router
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Recoverer)
	// Note: no global timeout middleware - it kills WebSocket connections.
	// Individual handler timeouts are handled via context or http.Server settings.
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.AllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Public routes
	r.Get("/", h.HealthRoot)
	r.Get("/health", h.HealthCheck)

	// Protected API routes
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return jwtValidator.MiddlewareWithCookie(cfg.AuthCookieName, next)
		})

		// Overview & cluster
		r.Get("/api/v1/overview", h.GetOverview)
		r.Get("/api/v1/api-resources", h.GetAPIResources)
		r.Get("/api/v1/cluster-config", h.GetClusterConfig)
		r.Get("/api/v1/componentstatuses", h.GetComponentStatuses)

		// Namespaces
		r.Get("/api/v1/namespaces", h.GetNamespaces)
		r.Post("/api/v1/namespaces", h.CreateNamespace)
		r.Get("/api/v1/namespaces/{namespace}/describe", h.DescribeNamespace)
		r.Get("/api/v1/namespaces/{namespace}/yaml", h.GetNamespaceYAML)
		r.Post("/api/v1/namespaces/{namespace}/yaml/apply", h.ApplyNamespaceYAML)
		r.Delete("/api/v1/namespaces/{namespace}", h.DeleteNamespace)
		r.Get("/api/v1/namespaces/{namespace}/resource-quotas", h.GetNamespaceResourceQuotas)
		r.Get("/api/v1/namespaces/{namespace}/limit-ranges", h.GetNamespaceLimitRanges)
		r.Get("/api/v1/namespaces/{namespace}/owned-pods", h.GetNamespaceOwnedPods)

		// Pods
		r.Get("/api/v1/pods/all", h.GetAllPods)
		r.Get("/api/v1/namespaces/{namespace}/pods", h.GetPods)
		r.Get("/api/v1/namespaces/{namespace}/pods/{name}/describe", h.DescribePod)
		r.Get("/api/v1/namespaces/{namespace}/pods/{name}/yaml", h.GetPodYAML)
		r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logs", h.GetPodLogs)
		r.Get("/api/v1/namespaces/{namespace}/pods/{name}/logs/ws", h.PodLogsWS)
		r.Get("/api/v1/namespaces/{namespace}/pods/{name}/rbac", h.GetPodRBAC)
		r.Delete("/api/v1/namespaces/{namespace}/pods/{pod_name}", h.DeletePod)
		r.Get("/api/v1/namespaces/{namespace}/pods/{name}/exec/ws", h.PodExecWS)

		// Deployments
		r.Get("/api/v1/deployments/all", h.GetAllDeployments)
		r.Get("/api/v1/namespaces/{namespace}/deployments", h.GetDeployments)
		r.Get("/api/v1/namespaces/{namespace}/deployments/{name}/describe", h.DescribeDeployment)
		r.Get("/api/v1/namespaces/{namespace}/deployments/{name}/yaml", h.GetDeploymentYAML)
		r.Delete("/api/v1/namespaces/{namespace}/deployments/{deployment_name}", h.DeleteDeployment)

		// Services
		r.Get("/api/v1/services/all", h.GetAllServices)
		r.Get("/api/v1/namespaces/{namespace}/services", h.GetServices)
		r.Get("/api/v1/namespaces/{namespace}/services/{name}/describe", h.DescribeService)
		r.Get("/api/v1/namespaces/{namespace}/services/{name}/yaml", h.GetServiceYAML)
		r.Delete("/api/v1/namespaces/{namespace}/services/{name}", h.DeleteService)
		r.Get("/api/v1/namespaces/{namespace}/services/{service_name}/connectivity", h.CheckServiceConnectivity)

		// Storage - PVCs
		r.Get("/api/v1/pvcs", h.GetAllPVCs)
		r.Get("/api/v1/namespaces/{namespace}/pvcs", h.GetPVCs)
		r.Get("/api/v1/namespaces/{namespace}/pvcs/{name}/describe", h.DescribePVC)
		r.Get("/api/v1/namespaces/{namespace}/pvcs/{name}/yaml", h.GetPVCYAML)
		r.Delete("/api/v1/namespaces/{namespace}/pvcs/{name}", h.DeletePVC)

		// Storage - PVs
		r.Get("/api/v1/pvs", h.GetPVs)
		r.Get("/api/v1/pvs/{name}", h.GetPV)
		r.Get("/api/v1/pvs/{name}/describe", h.DescribePV)
		r.Get("/api/v1/pvs/{name}/yaml", h.GetPVYAML)
		r.Delete("/api/v1/pvs/{name}", h.DeletePV)

		// Storage - StorageClasses
		r.Get("/api/v1/storageclasses", h.GetStorageClasses)
		r.Get("/api/v1/storageclasses/{name}", h.GetStorageClass)
		r.Get("/api/v1/storageclasses/{name}/describe", h.DescribeStorageClass)
		r.Delete("/api/v1/storageclasses/{name}", h.DeleteStorageClass)

		// Storage - VolumeAttachments
		r.Get("/api/v1/volumeattachments", h.GetVolumeAttachments)
		r.Get("/api/v1/volumeattachments/{name}/describe", h.DescribeVolumeAttachment)
		r.Delete("/api/v1/volumeattachments/{name}", h.DeleteVolumeAttachment)

		// Workloads - StatefulSets
		r.Get("/api/v1/statefulsets/all", h.GetAllStatefulSets)
		r.Get("/api/v1/namespaces/{namespace}/statefulsets", h.GetStatefulSets)
		r.Get("/api/v1/namespaces/{namespace}/statefulsets/{name}/describe", h.DescribeStatefulSet)
		r.Get("/api/v1/namespaces/{namespace}/statefulsets/{name}/yaml", h.GetStatefulSetYAML)
		r.Delete("/api/v1/namespaces/{namespace}/statefulsets/{name}", h.DeleteStatefulSet)

		// Workloads - DaemonSets
		r.Get("/api/v1/daemonsets/all", h.GetAllDaemonSets)
		r.Get("/api/v1/namespaces/{namespace}/daemonsets", h.GetDaemonSets)
		r.Get("/api/v1/namespaces/{namespace}/daemonsets/{name}/describe", h.DescribeDaemonSet)
		r.Get("/api/v1/namespaces/{namespace}/daemonsets/{name}/yaml", h.GetDaemonSetYAML)
		r.Delete("/api/v1/namespaces/{namespace}/daemonsets/{name}", h.DeleteDaemonSet)

		// Workloads - ReplicaSets
		r.Get("/api/v1/replicasets/all", h.GetAllReplicaSets)
		r.Get("/api/v1/namespaces/{namespace}/replicasets", h.GetReplicaSets)
		r.Get("/api/v1/namespaces/{namespace}/replicasets/{name}/describe", h.DescribeReplicaSet)
		r.Get("/api/v1/namespaces/{namespace}/replicasets/{name}/yaml", h.GetReplicaSetYAML)
		r.Delete("/api/v1/namespaces/{namespace}/replicasets/{name}", h.DeleteReplicaSet)

		// Workloads - Jobs
		r.Get("/api/v1/jobs/all", h.GetAllJobs)
		r.Get("/api/v1/namespaces/{namespace}/jobs", h.GetJobs)
		r.Get("/api/v1/namespaces/{namespace}/jobs/{name}/describe", h.DescribeJob)
		r.Get("/api/v1/namespaces/{namespace}/jobs/{name}/yaml", h.GetJobYAML)
		r.Delete("/api/v1/namespaces/{namespace}/jobs/{name}", h.DeleteJob)

		// Workloads - CronJobs
		r.Get("/api/v1/cronjobs/all", h.GetAllCronJobs)
		r.Get("/api/v1/namespaces/{namespace}/cronjobs", h.GetCronJobs)
		r.Get("/api/v1/namespaces/{namespace}/cronjobs/{name}/describe", h.DescribeCronJob)
		r.Get("/api/v1/namespaces/{namespace}/cronjobs/{name}/yaml", h.GetCronJobYAML)
		r.Delete("/api/v1/namespaces/{namespace}/cronjobs/{name}", h.DeleteCronJob)

		// Networking - Ingresses
		r.Get("/api/v1/ingresses/all", h.GetAllIngresses)
		r.Get("/api/v1/namespaces/{namespace}/ingresses", h.GetIngresses)
		r.Get("/api/v1/namespaces/{namespace}/ingresses/{name}/describe", h.DescribeIngress)
		r.Get("/api/v1/namespaces/{namespace}/ingresses/{name}/detail", h.GetIngressDetail)
		r.Get("/api/v1/namespaces/{namespace}/ingresses/{name}/yaml", h.GetIngressYAML)
		r.Delete("/api/v1/namespaces/{namespace}/ingresses/{name}", h.DeleteIngress)

		// Networking - IngressClasses
		r.Get("/api/v1/ingressclasses", h.GetIngressClasses)
		r.Get("/api/v1/ingressclasses/{name}/describe", h.DescribeIngressClass)
		r.Delete("/api/v1/ingressclasses/{name}", h.DeleteIngressClass)

		// Networking - Endpoints
		r.Get("/api/v1/endpoints/all", h.GetAllEndpoints)
		r.Get("/api/v1/namespaces/{namespace}/endpoints", h.GetEndpoints)
		r.Get("/api/v1/namespaces/{namespace}/endpoints/{name}/describe", h.DescribeEndpoints)
		r.Get("/api/v1/namespaces/{namespace}/endpoints/{name}/yaml", h.GetEndpointsYAML)
		r.Delete("/api/v1/namespaces/{namespace}/endpoints/{name}", h.DeleteEndpoints)

		// Networking - EndpointSlices
		r.Get("/api/v1/endpointslices/all", h.GetAllEndpointSlices)
		r.Get("/api/v1/namespaces/{namespace}/endpointslices", h.GetEndpointSlices)
		r.Get("/api/v1/namespaces/{namespace}/endpointslices/{name}/describe", h.DescribeEndpointSlice)
		r.Get("/api/v1/namespaces/{namespace}/endpointslices/{name}/yaml", h.GetEndpointSliceYAML)
		r.Delete("/api/v1/namespaces/{namespace}/endpointslices/{name}", h.DeleteEndpointSlice)

		// Networking - NetworkPolicies
		r.Get("/api/v1/networkpolicies/all", h.GetAllNetworkPolicies)
		r.Get("/api/v1/namespaces/{namespace}/networkpolicies", h.GetNetworkPolicies)
		r.Get("/api/v1/namespaces/{namespace}/networkpolicies/{name}/describe", h.DescribeNetworkPolicy)
		r.Get("/api/v1/namespaces/{namespace}/networkpolicies/{name}/yaml", h.GetNetworkPolicyYAML)
		r.Delete("/api/v1/namespaces/{namespace}/networkpolicies/{name}", h.DeleteNetworkPolicy)

		// Gateway API - Gateways
		r.Get("/api/v1/gateways/all", h.GetAllGateways)
		r.Get("/api/v1/namespaces/{namespace}/gateways", h.GetGateways)
		r.Get("/api/v1/namespaces/{namespace}/gateways/{name}/describe", h.DescribeGateway)
		r.Delete("/api/v1/namespaces/{namespace}/gateways/{name}", h.DeleteGateway)

		// Gateway API - GatewayClasses
		r.Get("/api/v1/gatewayclasses", h.GetGatewayClasses)
		r.Get("/api/v1/gatewayclasses/{name}/describe", h.DescribeGatewayClass)
		r.Delete("/api/v1/gatewayclasses/{name}", h.DeleteGatewayClass)

		// Gateway API - HTTPRoutes
		r.Get("/api/v1/httproutes/all", h.GetAllHTTPRoutes)
		r.Get("/api/v1/namespaces/{namespace}/httproutes", h.GetHTTPRoutes)
		r.Get("/api/v1/namespaces/{namespace}/httproutes/{name}/describe", h.DescribeHTTPRoute)
		r.Delete("/api/v1/namespaces/{namespace}/httproutes/{name}", h.DeleteHTTPRoute)

		// Gateway API - GRPCRoutes
		r.Get("/api/v1/grpcroutes/all", h.GetAllGRPCRoutes)
		r.Get("/api/v1/namespaces/{namespace}/grpcroutes", h.GetGRPCRoutes)
		r.Get("/api/v1/namespaces/{namespace}/grpcroutes/{name}/describe", h.DescribeGRPCRoute)
		r.Delete("/api/v1/namespaces/{namespace}/grpcroutes/{name}", h.DeleteGRPCRoute)

		// Gateway API - ReferenceGrants
		r.Get("/api/v1/referencegrants/all", h.GetAllReferenceGrants)
		r.Get("/api/v1/namespaces/{namespace}/referencegrants", h.GetReferenceGrants)
		r.Get("/api/v1/namespaces/{namespace}/referencegrants/{name}/describe", h.DescribeReferenceGrant)
		r.Delete("/api/v1/namespaces/{namespace}/referencegrants/{name}", h.DeleteReferenceGrant)

		// Gateway API - BackendTLSPolicies
		r.Get("/api/v1/backendtlspolicies/all", h.GetAllBackendTLSPolicies)
		r.Get("/api/v1/namespaces/{namespace}/backendtlspolicies", h.GetBackendTLSPolicies)
		r.Get("/api/v1/namespaces/{namespace}/backendtlspolicies/{name}/describe", h.DescribeBackendTLSPolicy)
		r.Delete("/api/v1/namespaces/{namespace}/backendtlspolicies/{name}", h.DeleteBackendTLSPolicy)

		// Gateway API - BackendTrafficPolicies
		r.Get("/api/v1/backendtrafficpolicies/all", h.GetAllBackendTrafficPolicies)
		r.Get("/api/v1/namespaces/{namespace}/backendtrafficpolicies", h.GetBackendTrafficPolicies)
		r.Get("/api/v1/namespaces/{namespace}/backendtrafficpolicies/{name}/describe", h.DescribeBackendTrafficPolicy)
		r.Delete("/api/v1/namespaces/{namespace}/backendtrafficpolicies/{name}", h.DeleteBackendTrafficPolicy)

		// Security - ServiceAccounts
		r.Get("/api/v1/serviceaccounts/all", h.GetAllServiceAccounts)
		r.Get("/api/v1/namespaces/{namespace}/serviceaccounts", h.GetServiceAccounts)
		r.Get("/api/v1/namespaces/{namespace}/serviceaccounts/{name}/describe", h.DescribeServiceAccount)
		r.Get("/api/v1/namespaces/{namespace}/serviceaccounts/{name}/yaml", h.GetServiceAccountYAML)
		r.Delete("/api/v1/namespaces/{namespace}/serviceaccounts/{name}", h.DeleteServiceAccount)

		// Security - Roles
		r.Get("/api/v1/roles/all", h.GetAllRoles)
		r.Get("/api/v1/namespaces/{namespace}/roles", h.GetRoles)
		r.Get("/api/v1/namespaces/{namespace}/roles/{name}/describe", h.DescribeRole)
		r.Get("/api/v1/namespaces/{namespace}/roles/{name}/yaml", h.GetRoleYAML)
		r.Delete("/api/v1/namespaces/{namespace}/roles/{name}", h.DeleteRole)

		// Security - RoleBindings
		r.Get("/api/v1/rolebindings/all", h.GetAllRoleBindings)
		r.Get("/api/v1/namespaces/{namespace}/rolebindings", h.GetRoleBindings)
		r.Get("/api/v1/namespaces/{namespace}/rolebindings/{name}/describe", h.DescribeRoleBinding)
		r.Get("/api/v1/namespaces/{namespace}/rolebindings/{name}/yaml", h.GetRoleBindingYAML)
		r.Delete("/api/v1/namespaces/{namespace}/rolebindings/{name}", h.DeleteRoleBinding)

		// GPU / DRA
		r.Get("/api/v1/gpu/dashboard", h.GetGPUDashboard)

		// DRA - DeviceClasses (cluster-scoped)
		r.Get("/api/v1/deviceclasses", h.GetDeviceClasses)
		r.Get("/api/v1/deviceclasses/{name}/describe", h.DescribeDeviceClass)
		r.Delete("/api/v1/deviceclasses/{name}", h.DeleteDeviceClass)

		// DRA - ResourceClaims (namespace-scoped)
		r.Get("/api/v1/resourceclaims/all", h.GetAllResourceClaims)
		r.Get("/api/v1/namespaces/{namespace}/resourceclaims", h.GetResourceClaims)
		r.Get("/api/v1/namespaces/{namespace}/resourceclaims/{name}/describe", h.DescribeResourceClaim)
		r.Delete("/api/v1/namespaces/{namespace}/resourceclaims/{name}", h.DeleteResourceClaim)

		// DRA - ResourceClaimTemplates (namespace-scoped)
		r.Get("/api/v1/resourceclaimtemplates/all", h.GetAllResourceClaimTemplates)
		r.Get("/api/v1/namespaces/{namespace}/resourceclaimtemplates", h.GetResourceClaimTemplates)
		r.Get("/api/v1/namespaces/{namespace}/resourceclaimtemplates/{name}/describe", h.DescribeResourceClaimTemplate)
		r.Delete("/api/v1/namespaces/{namespace}/resourceclaimtemplates/{name}", h.DeleteResourceClaimTemplate)

		// DRA - ResourceSlices (cluster-scoped)
		r.Get("/api/v1/resourceslices", h.GetResourceSlices)
		r.Get("/api/v1/resourceslices/{name}/describe", h.DescribeResourceSlice)
		r.Delete("/api/v1/resourceslices/{name}", h.DeleteResourceSlice)

		// Nodes
		r.Get("/api/v1/nodes", h.GetNodes)
		r.Get("/api/v1/nodes/{name}/describe", h.DescribeNode)
		r.Get("/api/v1/nodes/{name}/yaml", h.GetNodeYAML)
		r.Get("/api/v1/nodes/{name}/pods", h.GetNodePods)
		r.Get("/api/v1/nodes/{name}/events", h.GetNodeEvents)
		r.Delete("/api/v1/nodes/{name}", h.DeleteNode)
		r.Post("/api/v1/nodes/{name}/yaml/apply", h.ApplyNodeYAML)
		r.Post("/api/v1/nodes/{name}/cordon", h.CordonNode)
		r.Post("/api/v1/nodes/{name}/uncordon", h.UncordonNode)
		r.Post("/api/v1/nodes/{name}/drain", h.DrainNode)
		r.Get("/api/v1/nodes/{name}/drain/status", h.DrainNodeStatus)
		r.Get("/api/v1/nodes/{name}/debug-shell/ws", h.NodeDebugShellWS)

		// Events
		r.Get("/api/v1/events", h.GetEvents)
		r.Get("/api/v1/namespaces/{namespace}/events", h.GetNamespaceEvents)

		// Metrics
		r.Get("/api/v1/metrics/pods", h.GetPodMetrics)
		r.Get("/api/v1/metrics/nodes", h.GetNodeMetrics)
		r.Get("/api/v1/metrics/top-resources", h.GetTopResources)

		// ConfigMaps & Secrets
		r.Get("/api/v1/configmaps/all", h.GetAllConfigMaps)
		r.Get("/api/v1/namespaces/{namespace}/configmaps", h.GetConfigMaps)
		r.Get("/api/v1/namespaces/{namespace}/configmaps/{name}/describe", h.DescribeConfigMap)
		r.Get("/api/v1/namespaces/{namespace}/configmaps/{name}/yaml", h.GetConfigMapYAML)
		r.Delete("/api/v1/namespaces/{namespace}/configmaps/{name}", h.DeleteConfigMap)
		r.Get("/api/v1/secrets/all", h.GetAllSecrets)
		r.Get("/api/v1/namespaces/{namespace}/secrets", h.GetSecrets)
		r.Get("/api/v1/namespaces/{namespace}/secrets/{name}/describe", h.DescribeSecret)
		r.Get("/api/v1/namespaces/{namespace}/secrets/{name}/yaml", h.GetSecretYAML)

		// Generic resources
		r.Get("/api/v1/resources", h.GetGenericResources)
		r.Post("/api/v1/search", h.SearchResources)
		r.Get("/api/v1/resources/yaml", h.GetGenericResourceYAML)
		r.Post("/api/v1/resources/yaml/apply", h.ApplyResourceYAML)
		r.Post("/api/v1/resources/yaml/create", h.CreateResourcesFromYAML)
		r.Get("/api/v1/resources/describe", h.DescribeGenericResource)

		// HPA & PDB
		r.Get("/api/v1/namespaces/{namespace}/hpas", h.GetHPAs)
		r.Get("/api/v1/namespaces/{namespace}/pdbs", h.GetPDBs)

		// Topology
		r.Get("/api/v1/topology/namespace/{namespace}", h.GetNamespaceTopology)
		r.Get("/api/v1/topology/service/{namespace}/{service_name}", h.GetServiceTopology)
		r.Get("/api/v1/topology/deployment/{namespace}/{deployment_name}", h.GetDeploymentTopology)
		r.Get("/api/v1/topology/storage", h.GetStorageTopology)

		// WebSocket multiplexer (real-time watch)
		r.Get("/api/v1/ws", wsMux.HandleWebSocket)
		r.Get("/api/v1/wsMultiplexer", wsMux.HandleWebSocket)
	})

	// Create HTTP server
	// WriteTimeout=0 to support long-lived WebSocket connections
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		slog.Info("server listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-done
	slog.Info("shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("server shutdown error", "err", err)
	}

	slog.Info("server stopped")
}
