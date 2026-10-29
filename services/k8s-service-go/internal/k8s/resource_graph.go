package k8s

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Resource Graph edge types
const (
	RGEdgeOwns          = "owns"
	RGEdgeSelects       = "selects"
	RGEdgeMounts        = "mounts"
	RGEdgeRoutes        = "routes"
	RGEdgeBinds         = "binds"
	RGEdgeBoundTo       = "bound_to"
	RGEdgeProvisions    = "provisions"
	RGEdgeHPATargets    = "hpa_targets"
	RGEdgeNetworkPolicy = "network_policy"
	RGEdgeEndpointOf    = "endpoint_of"
	RGEdgeSAUsedBy      = "sa_used_by"
)

// rgNode represents a node in the resource graph.
type rgNode struct {
	ID            string            `json:"id"`
	Kind          string            `json:"kind"`
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	Status        string            `json:"status"`
	Ready         string            `json:"ready,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	NodeName      string            `json:"nodeName,omitempty"`
	OwnerKind     string            `json:"ownerKind,omitempty"`
	InstanceLabel string            `json:"instanceLabel,omitempty"`
	// a group of objects drawn as one (resource_graph_groups.go): its kind stays the members' kind
	Group     bool     `json:"group,omitempty"`
	Count     int      `json:"count,omitempty"`
	Members   []string `json:"members,omitempty"`
	OwnerName string   `json:"ownerName,omitempty"`
	Restarted int      `json:"restarted,omitempty"`
}

// rgEdge represents an edge in the resource graph. Count is how many edges a group's edge stands for.
type rgEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
	Count  int    `json:"count,omitempty"`
}

func rgNodeID(kind, namespace, name string) string {
	if namespace == "" {
		return fmt.Sprintf("%s//%s", kind, name)
	}
	return fmt.Sprintf("%s/%s/%s", kind, namespace, name)
}

// rgPod is what the graph reads from a pod. Pods are listed podListChunk at a time and kept in this form, so a
// namespace of many pods never holds the full objects.
type rgPod struct {
	name, namespace string
	labels          map[string]string
	owners          []metav1.OwnerReference
	node, phase     string
	ready           string
	health          uint8
	restarts        int32
	// what the pod mounts or reads env from, in the order the graph adds its edges
	refs []rgPodRef
}

type rgPodRef struct{ kind, name string }

func toRGPod(p *corev1.Pod) rgPod {
	health, _ := podHealth(p)
	out := rgPod{
		name: p.Name, namespace: p.Namespace, labels: p.Labels, node: p.Spec.NodeName,
		phase: string(p.Status.Phase), ready: podReadyCount(p), health: health,
	}
	for _, ref := range p.OwnerReferences {
		out.owners = append(out.owners, metav1.OwnerReference{Kind: ref.Kind, Name: ref.Name})
	}
	for _, cs := range p.Status.ContainerStatuses {
		out.restarts += cs.RestartCount
	}
	for _, vol := range p.Spec.Volumes {
		if vol.ConfigMap != nil {
			out.refs = append(out.refs, rgPodRef{"ConfigMap", vol.ConfigMap.Name})
		}
		if vol.Secret != nil {
			out.refs = append(out.refs, rgPodRef{"Secret", vol.Secret.SecretName})
		}
		if vol.PersistentVolumeClaim != nil {
			out.refs = append(out.refs, rgPodRef{"PersistentVolumeClaim", vol.PersistentVolumeClaim.ClaimName})
		}
	}
	for _, c := range p.Spec.Containers {
		for _, ef := range c.EnvFrom {
			if ef.ConfigMapRef != nil {
				out.refs = append(out.refs, rgPodRef{"ConfigMap", ef.ConfigMapRef.Name})
			}
			if ef.SecretRef != nil {
				out.refs = append(out.refs, rgPodRef{"Secret", ef.SecretRef.Name})
			}
		}
		for _, env := range c.Env {
			if env.ValueFrom == nil {
				continue
			}
			if env.ValueFrom.ConfigMapKeyRef != nil {
				out.refs = append(out.refs, rgPodRef{"ConfigMap", env.ValueFrom.ConfigMapKeyRef.Name})
			}
			if env.ValueFrom.SecretKeyRef != nil {
				out.refs = append(out.refs, rgPodRef{"Secret", env.ValueFrom.SecretKeyRef.Name})
			}
		}
	}
	return out
}

// ResourceGraphOptions: GroupPods folds the healthy pods of an owner with more than podGroupMin pods into
// groups (resource_graph_groups.go); GroupBy is the page's grouping, which a group does not cross; Expand names
// groups drawn pod by pod.
type ResourceGraphOptions struct {
	GroupPods bool
	GroupBy   string
	Expand    []string
}

func (o ResourceGraphOptions) cacheKey() string {
	if !o.GroupPods {
		return ""
	}
	expand := slices.Clone(o.Expand)
	slices.Sort(expand)
	return fmt.Sprintf("|groups:%s|%s", o.GroupBy, strings.Join(expand, ","))
}

// rgResources holds all fetched Kubernetes resources.
type rgResources struct {
	pods            []rgPod
	services        []corev1.Service
	configMaps      []corev1.ConfigMap
	secrets         []corev1.Secret
	pvcs            []corev1.PersistentVolumeClaim
	pvs             []corev1.PersistentVolume
	storageClasses  []storagev1.StorageClass
	ingresses       []networkingv1.Ingress
	roleBindings    []rbacv1.RoleBinding
	serviceAccounts []corev1.ServiceAccount
	replicaSets     []appsv1.ReplicaSet
	deployments     []appsv1.Deployment
	statefulSets    []appsv1.StatefulSet
	daemonSets      []appsv1.DaemonSet
	jobs            []batchv1.Job
	cronJobs        []batchv1.CronJob
	hpas            []autoscalingv2.HorizontalPodAutoscaler
	networkPolicies []networkingv1.NetworkPolicy
	endpointSlices  []discoveryv1.EndpointSlice
	forbidden       []string // kinds the identity may not list, left out
}

// GetResourceGraph returns a comprehensive resource graph for given namespaces.
// If namespaces is empty, it fetches across all namespaces.
func (s *Service) GetResourceGraph(ctx context.Context, namespaces []string, opts ResourceGraphOptions) (map[string]interface{}, error) {
	cacheKey := s.clusterCacheKey(ctx, fmt.Sprintf("resource-graph|%s%s", strings.Join(namespaces, ","), opts.cacheKey()))
	var cached map[string]interface{}
	if s.cache.Get(ctx, cacheKey, &cached) {
		return cached, nil
	}

	res, err := s.fetchResourceGraphData(ctx, namespaces)
	if err != nil {
		return nil, err
	}
	nodeMap, edges := buildResourceGraph(res, namespaces, opts)
	result := buildResourceGraphResponse(nodeMap, edges)
	if len(res.forbidden) > 0 {
		result["forbidden_kinds"] = res.forbidden
	}

	s.cache.Set(ctx, cacheKey, result, 30*time.Second)
	return result, nil
}

// buildResourceGraph draws the nodes and edges of what was fetched, the pods grouped when opts asks.
func buildResourceGraph(res *rgResources, namespaces []string, opts ResourceGraphOptions) (map[string]rgNode, []rgEdge) {
	// Filter by namespaces if multiple specified
	nsFilter := make(map[string]bool)
	if len(namespaces) > 1 {
		for _, n := range namespaces {
			nsFilter[n] = true
		}
	}
	inScope := func(namespace string) bool {
		if len(nsFilter) == 0 {
			return true
		}
		return nsFilter[namespace]
	}

	nodeMap := make(map[string]rgNode)
	edges := make([]rgEdge, 0, 512)

	addNode := func(n rgNode) {
		if _, exists := nodeMap[n.ID]; !exists {
			nodeMap[n.ID] = n
		}
	}

	// ========== BUILD NODES & EDGES ==========

	edges = buildWorkloadGraph(res, nodeMap, addNode, edges, inScope)

	edges = buildNetworkConfigGraph(res, nodeMap, addNode, edges, inScope)

	edges = buildStorageRBACGraph(res, nodeMap, addNode, edges, inScope)

	if opts.GroupPods {
		edges = groupPods(nodeMap, edges, res.pods, opts)
	}
	return nodeMap, edges
}

// selectorMatchesStr checks if all key-value pairs in selector exist in labels.
func selectorMatchesStr(selector map[string]string, labels map[string]string) bool {
	if len(selector) == 0 {
		return false
	}
	if len(labels) == 0 {
		return false
	}
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}
