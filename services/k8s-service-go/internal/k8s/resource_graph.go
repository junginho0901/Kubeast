package k8s

import (
	"context"
	"fmt"
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
}

// rgEdge represents an edge in the resource graph.
type rgEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}

func rgNodeID(kind, namespace, name string) string {
	if namespace == "" {
		return fmt.Sprintf("%s//%s", kind, name)
	}
	return fmt.Sprintf("%s/%s/%s", kind, namespace, name)
}

// rgResources holds all fetched Kubernetes resources.
type rgResources struct {
	pods            []corev1.Pod
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
	endpoints       []corev1.Endpoints
}

// GetResourceGraph returns a comprehensive resource graph for given namespaces.
// If namespaces is empty, it fetches across all namespaces.
func (s *Service) GetResourceGraph(ctx context.Context, namespaces []string) (map[string]interface{}, error) {
	cacheKey := fmt.Sprintf("resource-graph|%s", strings.Join(namespaces, ","))
	var cached map[string]interface{}
	if s.cache.Get(ctx, cacheKey, &cached) {
		return cached, nil
	}

	res, err := s.fetchResourceGraphData(ctx, namespaces)
	if err != nil {
		return nil, err
	}

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

	// --- PVCs ---
	for i := range res.pvcs {
		pvc := &res.pvcs[i]
		if !inScope(pvc.Namespace) {
			continue
		}
		pvcID := rgNodeID("PersistentVolumeClaim", pvc.Namespace, pvc.Name)
		addNode(rgNode{
			ID: pvcID, Kind: "PersistentVolumeClaim",
			Name: pvc.Name, Namespace: pvc.Namespace, Status: string(pvc.Status.Phase),
		})
		// PVC → PV (bound_to)
		if pvc.Spec.VolumeName != "" {
			pvID := rgNodeID("PersistentVolume", "", pvc.Spec.VolumeName)
			edges = append(edges, rgEdge{Source: pvcID, Target: pvID, Type: RGEdgeBoundTo})
		}
	}

	// --- PVs (cluster-scoped) ---
	for i := range res.pvs {
		pv := &res.pvs[i]
		pvID := rgNodeID("PersistentVolume", "", pv.Name)
		addNode(rgNode{
			ID: pvID, Kind: "PersistentVolume",
			Name: pv.Name, Status: string(pv.Status.Phase),
		})
		// PV → StorageClass (provisions)
		if pv.Spec.StorageClassName != "" {
			scID := rgNodeID("StorageClass", "", pv.Spec.StorageClassName)
			edges = append(edges, rgEdge{Source: scID, Target: pvID, Type: RGEdgeProvisions})
		}
	}

	// --- StorageClasses (cluster-scoped) ---
	for i := range res.storageClasses {
		sc := &res.storageClasses[i]
		addNode(rgNode{
			ID: rgNodeID("StorageClass", "", sc.Name), Kind: "StorageClass",
			Name: sc.Name, Status: sc.Provisioner,
		})
	}

	// --- RoleBindings → Role/ClusterRole, ServiceAccount ---
	for i := range res.roleBindings {
		rb := &res.roleBindings[i]
		if !inScope(rb.Namespace) {
			continue
		}
		rbID := rgNodeID("RoleBinding", rb.Namespace, rb.Name)
		addNode(rgNode{
			ID: rbID, Kind: "RoleBinding",
			Name: rb.Name, Namespace: rb.Namespace, Status: "Active",
		})

		roleKind := rb.RoleRef.Kind
		roleName := rb.RoleRef.Name
		roleNS := rb.Namespace
		if roleKind == "ClusterRole" {
			roleNS = ""
		}
		roleID := rgNodeID(roleKind, roleNS, roleName)
		addNode(rgNode{
			ID: roleID, Kind: roleKind, Name: roleName, Namespace: roleNS, Status: "Active",
		})
		edges = append(edges, rgEdge{Source: rbID, Target: roleID, Type: RGEdgeBinds})

		for _, subj := range rb.Subjects {
			if subj.Kind == "ServiceAccount" {
				subjNS := subj.Namespace
				if subjNS == "" {
					subjNS = rb.Namespace
				}
				saID := rgNodeID("ServiceAccount", subjNS, subj.Name)
				addNode(rgNode{
					ID: saID, Kind: "ServiceAccount", Name: subj.Name, Namespace: subjNS, Status: "Active",
				})
				edges = append(edges, rgEdge{Source: rbID, Target: saID, Type: RGEdgeBinds})
			}
		}
	}

	// --- ServiceAccounts (ensure nodes exist) ---
	for i := range res.serviceAccounts {
		sa := &res.serviceAccounts[i]
		if !inScope(sa.Namespace) {
			continue
		}
		addNode(rgNode{
			ID: rgNodeID("ServiceAccount", sa.Namespace, sa.Name), Kind: "ServiceAccount",
			Name: sa.Name, Namespace: sa.Namespace, Status: "Active",
		})
	}

	// --- ServiceAccount used by Deployments/DaemonSets ---
	for i := range res.deployments {
		d := &res.deployments[i]
		if !inScope(d.Namespace) {
			continue
		}
		saName := d.Spec.Template.Spec.ServiceAccountName
		if saName == "" {
			saName = "default"
		}
		saID := rgNodeID("ServiceAccount", d.Namespace, saName)
		if _, exists := nodeMap[saID]; exists {
			edges = append(edges, rgEdge{
				Source: saID,
				Target: rgNodeID("Deployment", d.Namespace, d.Name),
				Type:   RGEdgeSAUsedBy,
			})
		}
	}
	for i := range res.daemonSets {
		ds := &res.daemonSets[i]
		if !inScope(ds.Namespace) {
			continue
		}
		saName := ds.Spec.Template.Spec.ServiceAccountName
		if saName == "" {
			saName = "default"
		}
		saID := rgNodeID("ServiceAccount", ds.Namespace, saName)
		if _, exists := nodeMap[saID]; exists {
			edges = append(edges, rgEdge{
				Source: saID,
				Target: rgNodeID("DaemonSet", ds.Namespace, ds.Name),
				Type:   RGEdgeSAUsedBy,
			})
		}
	}

	// ========== DEDUPLICATE EDGES ==========
	edgeSet := make(map[string]bool)
	uniqueEdges := make([]rgEdge, 0, len(edges))
	for _, e := range edges {
		key := e.Source + "|" + e.Target + "|" + e.Type
		if !edgeSet[key] {
			edgeSet[key] = true
			uniqueEdges = append(uniqueEdges, e)
		}
	}

	// ========== BUILD RESPONSE ==========
	nodeList := make([]map[string]interface{}, 0, len(nodeMap))
	for _, n := range nodeMap {
		node := map[string]interface{}{
			"id":        n.ID,
			"kind":      n.Kind,
			"name":      n.Name,
			"namespace": n.Namespace,
			"status":    n.Status,
		}
		if n.Ready != "" {
			node["ready"] = n.Ready
		}
		if len(n.Labels) > 0 {
			node["labels"] = n.Labels
		}
		if n.NodeName != "" {
			node["nodeName"] = n.NodeName
		}
		if n.OwnerKind != "" {
			node["ownerKind"] = n.OwnerKind
		}
		if n.InstanceLabel != "" {
			node["instanceLabel"] = n.InstanceLabel
		}
		nodeList = append(nodeList, node)
	}

	edgeList := make([]map[string]interface{}, 0, len(uniqueEdges))
	for _, e := range uniqueEdges {
		edgeList = append(edgeList, map[string]interface{}{
			"source": e.Source,
			"target": e.Target,
			"type":   e.Type,
		})
	}

	result := map[string]interface{}{
		"nodes": nodeList,
		"edges": edgeList,
	}

	s.cache.Set(ctx, cacheKey, result, 30*time.Second)
	return result, nil
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
