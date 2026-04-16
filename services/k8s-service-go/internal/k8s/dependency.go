package k8s

import (
	"context"
	"fmt"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Dependency edge types
const (
	DepEdgeOwns    = "owns"
	DepEdgeSelects = "selects"
	DepEdgeMounts  = "mounts"
	DepEdgeRoutes  = "routes"
	DepEdgeBinds   = "binds"
)

// depNode represents a node in the dependency graph.
type depNode struct {
	ID        string            `json:"id"`
	Kind      string            `json:"kind"`
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Status    string            `json:"status"`
	Ready     string            `json:"ready,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
}

// depEdge represents an edge in the dependency graph.
type depEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}

func depNodeID(kind, namespace, name string) string {
	return fmt.Sprintf("%s/%s/%s", kind, namespace, name)
}

// GetDependencyGraph returns the full resource dependency graph for a namespace.
func (s *Service) GetDependencyGraph(ctx context.Context, namespace string) (map[string]interface{}, error) {
	cacheKey := fmt.Sprintf("dep-graph|%s", namespace)
	var cached map[string]interface{}
	if s.cache.Get(ctx, cacheKey, &cached) {
		return cached, nil
	}

	type resources struct {
		pods           []corev1.Pod
		services       []corev1.Service
		configMaps     []corev1.ConfigMap
		secrets        []corev1.Secret
		pvcs           []corev1.PersistentVolumeClaim
		ingresses      []networkingv1.Ingress
		roleBindings   []rbacv1.RoleBinding
		serviceAccounts []corev1.ServiceAccount
	}

	var res resources
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error

	fetchTyped := func(name string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", name, err)
				}
				mu.Unlock()
			}
		}()
	}

	fetchTyped("pods", func() error {
		list, err := s.Clientset().CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pods = list.Items
		mu.Unlock()
		return nil
	})

	fetchTyped("services", func() error {
		list, err := s.Clientset().CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.services = list.Items
		mu.Unlock()
		return nil
	})

	fetchTyped("configmaps", func() error {
		list, err := s.Clientset().CoreV1().ConfigMaps(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.configMaps = list.Items
		mu.Unlock()
		return nil
	})

	fetchTyped("secrets", func() error {
		list, err := s.Clientset().CoreV1().Secrets(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.secrets = list.Items
		mu.Unlock()
		return nil
	})

	fetchTyped("pvcs", func() error {
		list, err := s.Clientset().CoreV1().PersistentVolumeClaims(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvcs = list.Items
		mu.Unlock()
		return nil
	})

	fetchTyped("ingresses", func() error {
		list, err := s.Clientset().NetworkingV1().Ingresses(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.ingresses = list.Items
		mu.Unlock()
		return nil
	})

	fetchTyped("rolebindings", func() error {
		list, err := s.Clientset().RbacV1().RoleBindings(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.roleBindings = list.Items
		mu.Unlock()
		return nil
	})

	fetchTyped("serviceaccounts", func() error {
		list, err := s.Clientset().CoreV1().ServiceAccounts(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.serviceAccounts = list.Items
		mu.Unlock()
		return nil
	})

	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}

	nodeMap := make(map[string]depNode)
	edges := make([]depEdge, 0, 256)

	addNode := func(n depNode) {
		if _, exists := nodeMap[n.ID]; !exists {
			nodeMap[n.ID] = n
		}
	}

	// --- Build nodes ---

	// Pods + ownerReferences
	for i := range res.pods {
		pod := &res.pods[i]
		status := string(pod.Status.Phase)
		ready := podReadyCount(pod)
		addNode(depNode{
			ID:        depNodeID("Pod", namespace, pod.Name),
			Kind:      "Pod",
			Name:      pod.Name,
			Namespace: namespace,
			Status:    status,
			Ready:     ready,
			Labels:    pod.Labels,
		})

		// ownerReferences → owns edges
		for _, ref := range pod.OwnerReferences {
			ownerID := depNodeID(ref.Kind, namespace, ref.Name)
			addNode(depNode{
				ID:        ownerID,
				Kind:      ref.Kind,
				Name:      ref.Name,
				Namespace: namespace,
				Status:    "Running",
			})
			edges = append(edges, depEdge{
				Source: ownerID,
				Target: depNodeID("Pod", namespace, pod.Name),
				Type:   DepEdgeOwns,
			})

			// If owner is ReplicaSet, look for its owner (Deployment)
			if ref.Kind == "ReplicaSet" {
				for j := range res.pods {
					// Find any pod owned by same RS to get RS ownerRef
					// Instead, we track RS→Deployment via pod ownerRef chain
					_ = j
				}
			}
		}

		// volume mounts → ConfigMap, Secret, PVC
		for _, vol := range pod.Spec.Volumes {
			if vol.ConfigMap != nil {
				cmID := depNodeID("ConfigMap", namespace, vol.ConfigMap.Name)
				addNode(depNode{
					ID:        cmID,
					Kind:      "ConfigMap",
					Name:      vol.ConfigMap.Name,
					Namespace: namespace,
					Status:    "Active",
				})
				edges = append(edges, depEdge{
					Source: depNodeID("Pod", namespace, pod.Name),
					Target: cmID,
					Type:   DepEdgeMounts,
				})
			}
			if vol.Secret != nil {
				sID := depNodeID("Secret", namespace, vol.Secret.SecretName)
				addNode(depNode{
					ID:        sID,
					Kind:      "Secret",
					Name:      vol.Secret.SecretName,
					Namespace: namespace,
					Status:    "Active",
				})
				edges = append(edges, depEdge{
					Source: depNodeID("Pod", namespace, pod.Name),
					Target: sID,
					Type:   DepEdgeMounts,
				})
			}
			if vol.PersistentVolumeClaim != nil {
				pvcID := depNodeID("PersistentVolumeClaim", namespace, vol.PersistentVolumeClaim.ClaimName)
				addNode(depNode{
					ID:        pvcID,
					Kind:      "PersistentVolumeClaim",
					Name:      vol.PersistentVolumeClaim.ClaimName,
					Namespace: namespace,
					Status:    "Bound",
				})
				edges = append(edges, depEdge{
					Source: depNodeID("Pod", namespace, pod.Name),
					Target: pvcID,
					Type:   DepEdgeMounts,
				})
			}
		}

		// envFrom references
		for _, c := range pod.Spec.Containers {
			for _, ef := range c.EnvFrom {
				if ef.ConfigMapRef != nil {
					cmID := depNodeID("ConfigMap", namespace, ef.ConfigMapRef.Name)
					addNode(depNode{
						ID: cmID, Kind: "ConfigMap", Name: ef.ConfigMapRef.Name,
						Namespace: namespace, Status: "Active",
					})
					edges = append(edges, depEdge{
						Source: depNodeID("Pod", namespace, pod.Name),
						Target: cmID, Type: DepEdgeMounts,
					})
				}
				if ef.SecretRef != nil {
					sID := depNodeID("Secret", namespace, ef.SecretRef.Name)
					addNode(depNode{
						ID: sID, Kind: "Secret", Name: ef.SecretRef.Name,
						Namespace: namespace, Status: "Active",
					})
					edges = append(edges, depEdge{
						Source: depNodeID("Pod", namespace, pod.Name),
						Target: sID, Type: DepEdgeMounts,
					})
				}
			}
			for _, env := range c.Env {
				if env.ValueFrom == nil {
					continue
				}
				if env.ValueFrom.ConfigMapKeyRef != nil {
					cmID := depNodeID("ConfigMap", namespace, env.ValueFrom.ConfigMapKeyRef.Name)
					addNode(depNode{
						ID: cmID, Kind: "ConfigMap", Name: env.ValueFrom.ConfigMapKeyRef.Name,
						Namespace: namespace, Status: "Active",
					})
					edges = append(edges, depEdge{
						Source: depNodeID("Pod", namespace, pod.Name),
						Target: cmID, Type: DepEdgeMounts,
					})
				}
				if env.ValueFrom.SecretKeyRef != nil {
					sID := depNodeID("Secret", namespace, env.ValueFrom.SecretKeyRef.Name)
					addNode(depNode{
						ID: sID, Kind: "Secret", Name: env.ValueFrom.SecretKeyRef.Name,
						Namespace: namespace, Status: "Active",
					})
					edges = append(edges, depEdge{
						Source: depNodeID("Pod", namespace, pod.Name),
						Target: sID, Type: DepEdgeMounts,
					})
				}
			}
		}
	}

	// Build ReplicaSet owner chain: find RS owners from appsV1
	// Fetch ReplicaSets to trace Deployment → ReplicaSet chain
	rsList, err := s.Clientset().AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err == nil {
		for i := range rsList.Items {
			rs := &rsList.Items[i]
			rsID := depNodeID("ReplicaSet", namespace, rs.Name)
			// Ensure RS node exists
			if _, exists := nodeMap[rsID]; !exists {
				// Only add if it was referenced by a pod
				continue
			}
			for _, ref := range rs.OwnerReferences {
				if ref.Kind == "Deployment" {
					depID := depNodeID("Deployment", namespace, ref.Name)
					addNode(depNode{
						ID:        depID,
						Kind:      "Deployment",
						Name:      ref.Name,
						Namespace: namespace,
						Status:    "Running",
					})
					edges = append(edges, depEdge{
						Source: depID,
						Target: rsID,
						Type:   DepEdgeOwns,
					})
				}
			}
		}
	}

	// Fetch Jobs to trace CronJob → Job chain
	jobList, err := s.Clientset().BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{})
	if err == nil {
		for i := range jobList.Items {
			job := &jobList.Items[i]
			jobID := depNodeID("Job", namespace, job.Name)
			if _, exists := nodeMap[jobID]; !exists {
				continue
			}
			for _, ref := range job.OwnerReferences {
				if ref.Kind == "CronJob" {
					cjID := depNodeID("CronJob", namespace, ref.Name)
					addNode(depNode{
						ID:        cjID,
						Kind:      "CronJob",
						Name:      ref.Name,
						Namespace: namespace,
						Status:    "Active",
					})
					edges = append(edges, depEdge{
						Source: cjID,
						Target: jobID,
						Type:   DepEdgeOwns,
					})
				}
			}
		}
	}

	// Services → selector matching to Pods
	for i := range res.services {
		svc := &res.services[i]
		svcID := depNodeID("Service", namespace, svc.Name)
		addNode(depNode{
			ID:        svcID,
			Kind:      "Service",
			Name:      svc.Name,
			Namespace: namespace,
			Status:    "Active",
		})

		if len(svc.Spec.Selector) == 0 {
			continue
		}
		for j := range res.pods {
			pod := &res.pods[j]
			if selectorMatches(svc.Spec.Selector, pod.Labels) {
				edges = append(edges, depEdge{
					Source: svcID,
					Target: depNodeID("Pod", namespace, pod.Name),
					Type:   DepEdgeSelects,
				})
			}
		}
	}

	// ConfigMaps & Secrets (ensure they exist as nodes)
	for i := range res.configMaps {
		cm := &res.configMaps[i]
		addNode(depNode{
			ID:        depNodeID("ConfigMap", namespace, cm.Name),
			Kind:      "ConfigMap",
			Name:      cm.Name,
			Namespace: namespace,
			Status:    "Active",
		})
	}
	for i := range res.secrets {
		sec := &res.secrets[i]
		addNode(depNode{
			ID:        depNodeID("Secret", namespace, sec.Name),
			Kind:      "Secret",
			Name:      sec.Name,
			Namespace: namespace,
			Status:    "Active",
		})
	}

	// PVCs
	for i := range res.pvcs {
		pvc := &res.pvcs[i]
		pvcID := depNodeID("PersistentVolumeClaim", namespace, pvc.Name)
		status := string(pvc.Status.Phase)
		addNode(depNode{
			ID:        pvcID,
			Kind:      "PersistentVolumeClaim",
			Name:      pvc.Name,
			Namespace: namespace,
			Status:    status,
		})
		if pvc.Spec.VolumeName != "" {
			pvID := depNodeID("PersistentVolume", "", pvc.Spec.VolumeName)
			addNode(depNode{
				ID:        pvID,
				Kind:      "PersistentVolume",
				Name:      pvc.Spec.VolumeName,
				Namespace: "",
				Status:    "Bound",
			})
			edges = append(edges, depEdge{
				Source: pvcID,
				Target: pvID,
				Type:   DepEdgeMounts,
			})
		}
	}

	// Ingresses → Service
	for i := range res.ingresses {
		ing := &res.ingresses[i]
		ingID := depNodeID("Ingress", namespace, ing.Name)
		addNode(depNode{
			ID:        ingID,
			Kind:      "Ingress",
			Name:      ing.Name,
			Namespace: namespace,
			Status:    "Active",
		})
		for _, rule := range ing.Spec.Rules {
			if rule.HTTP == nil {
				continue
			}
			for _, path := range rule.HTTP.Paths {
				if path.Backend.Service != nil {
					svcID := depNodeID("Service", namespace, path.Backend.Service.Name)
					addNode(depNode{
						ID: svcID, Kind: "Service", Name: path.Backend.Service.Name,
						Namespace: namespace, Status: "Active",
					})
					edges = append(edges, depEdge{
						Source: ingID,
						Target: svcID,
						Type:   DepEdgeRoutes,
					})
				}
			}
		}
		// default backend
		if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
			svcID := depNodeID("Service", namespace, ing.Spec.DefaultBackend.Service.Name)
			addNode(depNode{
				ID: svcID, Kind: "Service", Name: ing.Spec.DefaultBackend.Service.Name,
				Namespace: namespace, Status: "Active",
			})
			edges = append(edges, depEdge{
				Source: ingID,
				Target: svcID,
				Type:   DepEdgeRoutes,
			})
		}
	}

	// RoleBindings → ServiceAccount, Role/ClusterRole
	for i := range res.roleBindings {
		rb := &res.roleBindings[i]
		rbID := depNodeID("RoleBinding", namespace, rb.Name)
		addNode(depNode{
			ID:        rbID,
			Kind:      "RoleBinding",
			Name:      rb.Name,
			Namespace: namespace,
			Status:    "Active",
		})

		// roleRef
		roleKind := rb.RoleRef.Kind
		roleName := rb.RoleRef.Name
		roleNS := namespace
		if roleKind == "ClusterRole" {
			roleNS = ""
		}
		roleID := depNodeID(roleKind, roleNS, roleName)
		addNode(depNode{
			ID:        roleID,
			Kind:      roleKind,
			Name:      roleName,
			Namespace: roleNS,
			Status:    "Active",
		})
		edges = append(edges, depEdge{
			Source: rbID,
			Target: roleID,
			Type:   DepEdgeBinds,
		})

		// subjects
		for _, subj := range rb.Subjects {
			if subj.Kind == "ServiceAccount" {
				subjNS := subj.Namespace
				if subjNS == "" {
					subjNS = namespace
				}
				saID := depNodeID("ServiceAccount", subjNS, subj.Name)
				addNode(depNode{
					ID:        saID,
					Kind:      "ServiceAccount",
					Name:      subj.Name,
					Namespace: subjNS,
					Status:    "Active",
				})
				edges = append(edges, depEdge{
					Source: rbID,
					Target: saID,
					Type:   DepEdgeBinds,
				})
			}
		}
	}

	// ServiceAccounts (ensure nodes exist)
	for i := range res.serviceAccounts {
		sa := &res.serviceAccounts[i]
		addNode(depNode{
			ID:        depNodeID("ServiceAccount", namespace, sa.Name),
			Kind:      "ServiceAccount",
			Name:      sa.Name,
			Namespace: namespace,
			Status:    "Active",
		})
	}

	// Deduplicate edges
	edgeSet := make(map[string]bool)
	uniqueEdges := make([]depEdge, 0, len(edges))
	for _, e := range edges {
		key := e.Source + "|" + e.Target + "|" + e.Type
		if !edgeSet[key] {
			edgeSet[key] = true
			uniqueEdges = append(uniqueEdges, e)
		}
	}

	// Convert to response
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

func podReadyCount(pod *corev1.Pod) string {
	total := len(pod.Spec.Containers)
	ready := 0
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Ready {
			ready++
		}
	}
	return fmt.Sprintf("%d/%d", ready, total)
}
