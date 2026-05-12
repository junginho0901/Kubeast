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

	// --- Services → selector matching to Pods ---
	for i := range res.services {
		svc := &res.services[i]
		if !inScope(svc.Namespace) {
			continue
		}
		svcID := rgNodeID("Service", svc.Namespace, svc.Name)
		svcType := string(svc.Spec.Type)
		addNode(rgNode{
			ID: svcID, Kind: "Service",
			Name: svc.Name, Namespace: svc.Namespace, Status: svcType,
			Labels: svc.Labels,
		})

		if len(svc.Spec.Selector) == 0 {
			continue
		}
		for j := range res.pods {
			pod := &res.pods[j]
			if pod.Namespace != svc.Namespace {
				continue
			}
			if selectorMatches(svc.Spec.Selector, pod.Labels) {
				edges = append(edges, rgEdge{
					Source: svcID,
					Target: rgNodeID("Pod", pod.Namespace, pod.Name),
					Type:   RGEdgeSelects,
				})
			}
		}
	}

	// --- ConfigMaps (ensure nodes exist) ---
	for i := range res.configMaps {
		cm := &res.configMaps[i]
		if !inScope(cm.Namespace) {
			continue
		}
		addNode(rgNode{
			ID: rgNodeID("ConfigMap", cm.Namespace, cm.Name), Kind: "ConfigMap",
			Name: cm.Name, Namespace: cm.Namespace, Status: "Active",
		})
	}

	// --- Secrets (ensure nodes exist) ---
	for i := range res.secrets {
		sec := &res.secrets[i]
		if !inScope(sec.Namespace) {
			continue
		}
		addNode(rgNode{
			ID: rgNodeID("Secret", sec.Namespace, sec.Name), Kind: "Secret",
			Name: sec.Name, Namespace: sec.Namespace, Status: "Active",
		})
	}

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

	// --- Ingresses → Service ---
	for i := range res.ingresses {
		ing := &res.ingresses[i]
		if !inScope(ing.Namespace) {
			continue
		}
		ingID := rgNodeID("Ingress", ing.Namespace, ing.Name)
		addNode(rgNode{
			ID: ingID, Kind: "Ingress",
			Name: ing.Name, Namespace: ing.Namespace, Status: "Active",
			Labels: ing.Labels,
		})
		for _, rule := range ing.Spec.Rules {
			if rule.HTTP == nil {
				continue
			}
			for _, path := range rule.HTTP.Paths {
				if path.Backend.Service != nil {
					svcID := rgNodeID("Service", ing.Namespace, path.Backend.Service.Name)
					edges = append(edges, rgEdge{Source: ingID, Target: svcID, Type: RGEdgeRoutes})
				}
			}
		}
		if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
			svcID := rgNodeID("Service", ing.Namespace, ing.Spec.DefaultBackend.Service.Name)
			edges = append(edges, rgEdge{Source: ingID, Target: svcID, Type: RGEdgeRoutes})
		}
	}

	// --- HPA → Deployment / StatefulSet ---
	for i := range res.hpas {
		hpa := &res.hpas[i]
		if !inScope(hpa.Namespace) {
			continue
		}
		hpaID := rgNodeID("HorizontalPodAutoscaler", hpa.Namespace, hpa.Name)
		ready := fmt.Sprintf("%d/%d", hpa.Status.CurrentReplicas, hpa.Status.DesiredReplicas)
		addNode(rgNode{
			ID: hpaID, Kind: "HorizontalPodAutoscaler",
			Name: hpa.Name, Namespace: hpa.Namespace, Status: "Active", Ready: ready,
		})
		targetKind := hpa.Spec.ScaleTargetRef.Kind
		targetName := hpa.Spec.ScaleTargetRef.Name
		targetID := rgNodeID(targetKind, hpa.Namespace, targetName)
		edges = append(edges, rgEdge{Source: hpaID, Target: targetID, Type: RGEdgeHPATargets})
	}

	// --- NetworkPolicy → Pod (selector matching) ---
	for i := range res.networkPolicies {
		np := &res.networkPolicies[i]
		if !inScope(np.Namespace) {
			continue
		}
		npID := rgNodeID("NetworkPolicy", np.Namespace, np.Name)
		addNode(rgNode{
			ID: npID, Kind: "NetworkPolicy",
			Name: np.Name, Namespace: np.Namespace, Status: "Active",
		})
		if np.Spec.PodSelector.MatchLabels != nil {
			for j := range res.pods {
				pod := &res.pods[j]
				if pod.Namespace != np.Namespace {
					continue
				}
				if selectorMatchesStr(np.Spec.PodSelector.MatchLabels, pod.Labels) {
					edges = append(edges, rgEdge{Source: npID, Target: rgNodeID("Pod", pod.Namespace, pod.Name), Type: RGEdgeNetworkPolicy})
				}
			}
		}
	}

	// --- EndpointSlices → Service ---
	for i := range res.endpointSlices {
		eps := &res.endpointSlices[i]
		if !inScope(eps.Namespace) {
			continue
		}
		// EndpointSlice owner is typically the Service
		svcName := eps.Labels["kubernetes.io/service-name"]
		if svcName != "" {
			epsID := rgNodeID("EndpointSlice", eps.Namespace, eps.Name)
			addNode(rgNode{
				ID: epsID, Kind: "EndpointSlice",
				Name: eps.Name, Namespace: eps.Namespace, Status: "Active",
			})
			svcID := rgNodeID("Service", eps.Namespace, svcName)
			edges = append(edges, rgEdge{Source: epsID, Target: svcID, Type: RGEdgeEndpointOf})
		}
	}

	// --- Endpoints → Service ---
	for i := range res.endpoints {
		ep := &res.endpoints[i]
		if !inScope(ep.Namespace) {
			continue
		}
		epID := rgNodeID("Endpoints", ep.Namespace, ep.Name)
		addNode(rgNode{
			ID: epID, Kind: "Endpoints",
			Name: ep.Name, Namespace: ep.Namespace, Status: "Active",
		})
		// Endpoints share name with Service
		svcID := rgNodeID("Service", ep.Namespace, ep.Name)
		if _, exists := nodeMap[svcID]; exists {
			edges = append(edges, rgEdge{Source: epID, Target: svcID, Type: RGEdgeEndpointOf})
		}
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
