package k8s

import (
	"context"
	"fmt"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Topology node/edge types matching the Python implementation
const (
	NodeTypeService     = "service"
	NodeTypeDeployment  = "deployment"
	NodeTypeStatefulSet = "statefulset"
	NodeTypeDaemonSet   = "daemonset"
	NodeTypePod         = "pod"
	NodeTypePVC         = "pvc"
	NodeTypePV          = "pv"
	NodeTypeConfigMap   = "configmap"
	NodeTypeSecret      = "secret"
	NodeTypeIngress     = "ingress"

	EdgeTypeRoutesTo = "routes_to"
	EdgeTypeManages  = "manages"
	EdgeTypeUses     = "uses"
	EdgeTypeMounts   = "mounts"
	EdgeTypeBoundTo  = "bound_to"
)

// GetNamespaceTopology returns a full namespace topology graph.
func (s *Service) GetNamespaceTopology(ctx context.Context, namespace string) (map[string]interface{}, error) {
	type result struct {
		services    []map[string]interface{}
		deployments []map[string]interface{}
		pods        []map[string]interface{}
		pvcs        []map[string]interface{}
	}

	var r result
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error

	fetch := func(name string, fn func() ([]map[string]interface{}, error), target *[]map[string]interface{}) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			data, err := fn()
			mu.Lock()
			defer mu.Unlock()
			if err != nil && firstErr == nil {
				firstErr = fmt.Errorf("%s: %w", name, err)
				return
			}
			*target = data
		}()
	}

	fetch("services", func() ([]map[string]interface{}, error) { return s.GetServices(ctx, namespace) }, &r.services)
	fetch("deployments", func() ([]map[string]interface{}, error) { return s.GetDeployments(ctx, namespace) }, &r.deployments)
	fetch("pods", func() ([]map[string]interface{}, error) { return s.GetPods(ctx, namespace, "") }, &r.pods)
	fetch("pvcs", func() ([]map[string]interface{}, error) { return s.GetPVCs(ctx, namespace) }, &r.pvcs)

	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}

	nodes := make([]map[string]interface{}, 0)
	edges := make([]map[string]interface{}, 0)
	edgeID := 0

	// Add service nodes
	for _, svc := range r.services {
		nodes = append(nodes, map[string]interface{}{
			"id":        fmt.Sprintf("svc-%s", svc["name"]),
			"type":      NodeTypeService,
			"name":      svc["name"],
			"namespace": namespace,
			"status":    "Active",
			"metadata": map[string]interface{}{
				"type":       svc["type"],
				"cluster_ip": svc["cluster_ip"],
				"ports":      svc["ports"],
			},
		})
	}

	// Add deployment nodes
	for _, dep := range r.deployments {
		status := "Progressing"
		if s, ok := dep["status"].(string); ok {
			status = s
		}
		nodes = append(nodes, map[string]interface{}{
			"id":        fmt.Sprintf("dep-%s", dep["name"]),
			"type":      NodeTypeDeployment,
			"name":      dep["name"],
			"namespace": namespace,
			"status":    status,
			"metadata": map[string]interface{}{
				"replicas":       dep["replicas"],
				"ready_replicas": dep["ready_replicas"],
				"image":          dep["image"],
			},
		})
	}

	// Add pod nodes
	for _, pod := range r.pods {
		nodes = append(nodes, map[string]interface{}{
			"id":        fmt.Sprintf("pod-%s", pod["name"]),
			"type":      NodeTypePod,
			"name":      pod["name"],
			"namespace": namespace,
			"status":    pod["status"],
			"metadata": map[string]interface{}{
				"node_name": pod["node_name"],
				"pod_ip":    pod["pod_ip"],
				"ready":     pod["ready"],
			},
		})
	}

	// Add PVC nodes
	for _, pvc := range r.pvcs {
		nodes = append(nodes, map[string]interface{}{
			"id":        fmt.Sprintf("pvc-%s", pvc["name"]),
			"type":      NodeTypePVC,
			"name":      pvc["name"],
			"namespace": namespace,
			"status":    pvc["status"],
			"metadata": map[string]interface{}{
				"capacity":      pvc["capacity"],
				"storage_class": pvc["storage_class"],
			},
		})
	}

	// Create edges: Service → Deployment (selector matching)
	for _, svc := range r.services {
		svcSelector, _ := svc["selector"].(map[string]string)
		if len(svcSelector) == 0 {
			continue
		}
		for _, dep := range r.deployments {
			depSelector := extractStringMap(dep, "selector")
			if selectorMatches(svcSelector, depSelector) {
				edgeID++
				edges = append(edges, map[string]interface{}{
					"id":     fmt.Sprintf("edge-%d", edgeID),
					"source": fmt.Sprintf("svc-%s", svc["name"]),
					"target": fmt.Sprintf("dep-%s", dep["name"]),
					"type":   EdgeTypeRoutesTo,
					"label":  "routes to",
				})
			}
		}
	}

	// Create edges: Deployment → Pod (selector matching)
	for _, dep := range r.deployments {
		depSelector := extractStringMap(dep, "selector")
		if len(depSelector) == 0 {
			continue
		}
		for _, pod := range r.pods {
			podLabels := extractStringMap(pod, "labels")
			if selectorMatches(depSelector, podLabels) {
				edgeID++
				edges = append(edges, map[string]interface{}{
					"id":     fmt.Sprintf("edge-%d", edgeID),
					"source": fmt.Sprintf("dep-%s", dep["name"]),
					"target": fmt.Sprintf("pod-%s", pod["name"]),
					"type":   EdgeTypeManages,
					"label":  "manages",
				})
			}
		}
	}

	// Create edges: PVC → PV (volume binding)
	for _, pvc := range r.pvcs {
		volumeName, _ := pvc["volume_name"].(string)
		if volumeName != "" {
			edgeID++
			edges = append(edges, map[string]interface{}{
				"id":     fmt.Sprintf("edge-%d", edgeID),
				"source": fmt.Sprintf("pvc-%s", pvc["name"]),
				"target": fmt.Sprintf("pv-%s", volumeName),
				"type":   EdgeTypeBoundTo,
				"label":  "bound to",
			})
		}
	}

	return map[string]interface{}{
		"nodes": nodes,
		"edges": edges,
		"metadata": map[string]interface{}{
			"namespace":  namespace,
			"node_count": len(nodes),
			"edge_count": len(edges),
		},
	}, nil
}

// GetServiceTopology returns a topology graph centered on a service.
func (s *Service) GetServiceTopology(ctx context.Context, namespace, serviceName string) (map[string]interface{}, error) {
	svc, err := s.Clientset().CoreV1().Services(namespace).Get(ctx, serviceName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get service %s/%s: %w", namespace, serviceName, err)
	}

	nodes := make([]map[string]interface{}, 0)
	edges := make([]map[string]interface{}, 0)
	edgeID := 0

	// Service node
	nodes = append(nodes, map[string]interface{}{
		"id":        fmt.Sprintf("svc-%s", svc.Name),
		"type":      NodeTypeService,
		"name":      svc.Name,
		"namespace": namespace,
		"status":    "Active",
		"metadata": map[string]interface{}{
			"type":       string(svc.Spec.Type),
			"cluster_ip": svc.Spec.ClusterIP,
		},
	})

	selector := svc.Spec.Selector
	if len(selector) == 0 {
		return map[string]interface{}{
			"nodes":    nodes,
			"edges":    edges,
			"metadata": map[string]interface{}{"namespace": namespace},
		}, nil
	}

	// Find matching deployments and pods in parallel
	var deps []map[string]interface{}
	var pods []map[string]interface{}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		deps, _ = s.GetDeployments(ctx, namespace)
	}()
	go func() {
		defer wg.Done()
		pods, _ = s.GetPods(ctx, namespace, "")
	}()
	wg.Wait()

	for _, dep := range deps {
		depSelector := extractStringMap(dep, "selector")
		if selectorMatches(selector, depSelector) {
			nodes = append(nodes, map[string]interface{}{
				"id":        fmt.Sprintf("dep-%s", dep["name"]),
				"type":      NodeTypeDeployment,
				"name":      dep["name"],
				"namespace": namespace,
				"status":    dep["status"],
				"metadata": map[string]interface{}{
					"replicas":       dep["replicas"],
					"ready_replicas": dep["ready_replicas"],
				},
			})
			edgeID++
			edges = append(edges, map[string]interface{}{
				"id":     fmt.Sprintf("edge-%d", edgeID),
				"source": fmt.Sprintf("svc-%s", svc.Name),
				"target": fmt.Sprintf("dep-%s", dep["name"]),
				"type":   EdgeTypeRoutesTo,
				"label":  "routes to",
			})
		}
	}

	for _, pod := range pods {
		podLabels := extractStringMap(pod, "labels")
		if selectorMatches(selector, podLabels) {
			nodes = append(nodes, map[string]interface{}{
				"id":        fmt.Sprintf("pod-%s", pod["name"]),
				"type":      NodeTypePod,
				"name":      pod["name"],
				"namespace": namespace,
				"status":    pod["status"],
				"metadata": map[string]interface{}{
					"node_name": pod["node_name"],
					"pod_ip":    pod["pod_ip"],
				},
			})
		}
	}

	return map[string]interface{}{
		"nodes":    nodes,
		"edges":    edges,
		"metadata": map[string]interface{}{"namespace": namespace, "service": serviceName},
	}, nil
}

// GetDeploymentTopology returns a topology graph centered on a deployment.
func (s *Service) GetDeploymentTopology(ctx context.Context, namespace, deploymentName string) (map[string]interface{}, error) {
	dep, err := s.Clientset().AppsV1().Deployments(namespace).Get(ctx, deploymentName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get deployment %s/%s: %w", namespace, deploymentName, err)
	}

	nodes := make([]map[string]interface{}, 0)
	edges := make([]map[string]interface{}, 0)
	edgeID := 0

	depStatus := "Progressing"
	for _, c := range dep.Status.Conditions {
		if c.Type == "Available" && c.Status == "True" {
			depStatus = "Available"
			break
		}
	}

	nodes = append(nodes, map[string]interface{}{
		"id":        fmt.Sprintf("dep-%s", dep.Name),
		"type":      NodeTypeDeployment,
		"name":      dep.Name,
		"namespace": namespace,
		"status":    depStatus,
		"metadata": map[string]interface{}{
			"replicas": dep.Status.ReadyReplicas,
		},
	})

	if dep.Spec.Selector == nil || len(dep.Spec.Selector.MatchLabels) == 0 {
		return map[string]interface{}{
			"nodes":    nodes,
			"edges":    edges,
			"metadata": map[string]interface{}{"namespace": namespace},
		}, nil
	}

	pods, _ := s.GetPods(ctx, namespace, "")
	selector := dep.Spec.Selector.MatchLabels

	for _, pod := range pods {
		podLabels := extractStringMap(pod, "labels")
		if selectorMatches(selector, podLabels) {
			nodes = append(nodes, map[string]interface{}{
				"id":        fmt.Sprintf("pod-%s", pod["name"]),
				"type":      NodeTypePod,
				"name":      pod["name"],
				"namespace": namespace,
				"status":    pod["status"],
				"metadata": map[string]interface{}{
					"node_name": pod["node_name"],
					"pod_ip":    pod["pod_ip"],
				},
			})
			edgeID++
			edges = append(edges, map[string]interface{}{
				"id":     fmt.Sprintf("edge-%d", edgeID),
				"source": fmt.Sprintf("dep-%s", dep.Name),
				"target": fmt.Sprintf("pod-%s", pod["name"]),
				"type":   EdgeTypeManages,
				"label":  "manages",
			})
		}
	}

	return map[string]interface{}{
		"nodes":    nodes,
		"edges":    edges,
		"metadata": map[string]interface{}{"namespace": namespace, "deployment": deploymentName},
	}, nil
}

// GetStorageTopology returns a topology graph for storage resources.
func (s *Service) GetStorageTopology(ctx context.Context) (map[string]interface{}, error) {
	var pvcs []map[string]interface{}
	var pvs []map[string]interface{}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		data, err := s.GetAllPVCs(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil && firstErr == nil {
			firstErr = err
		}
		pvcs = data
	}()
	go func() {
		defer wg.Done()
		data, err := s.GetPVs(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil && firstErr == nil {
			firstErr = err
		}
		pvs = data
	}()
	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}

	nodes := make([]map[string]interface{}, 0)
	edges := make([]map[string]interface{}, 0)
	edgeID := 0

	// PV nodes
	for _, pv := range pvs {
		nodes = append(nodes, map[string]interface{}{
			"id":     fmt.Sprintf("pv-%s", pv["name"]),
			"type":   NodeTypePV,
			"name":   pv["name"],
			"status": pv["status"],
			"metadata": map[string]interface{}{
				"capacity":      pv["capacity"],
				"storage_class": pv["storage_class"],
				"access_modes":  pv["access_modes"],
			},
		})
	}

	// PVC nodes + edges to PVs
	for _, pvc := range pvcs {
		ns, _ := pvc["namespace"].(string)
		nodes = append(nodes, map[string]interface{}{
			"id":        fmt.Sprintf("pvc-%s-%s", ns, pvc["name"]),
			"type":      NodeTypePVC,
			"name":      pvc["name"],
			"namespace": ns,
			"status":    pvc["status"],
			"metadata": map[string]interface{}{
				"capacity":      pvc["capacity"],
				"storage_class": pvc["storage_class"],
			},
		})

		volumeName, _ := pvc["volume_name"].(string)
		if volumeName != "" {
			edgeID++
			edges = append(edges, map[string]interface{}{
				"id":     fmt.Sprintf("edge-%d", edgeID),
				"source": fmt.Sprintf("pvc-%s-%s", ns, pvc["name"]),
				"target": fmt.Sprintf("pv-%s", volumeName),
				"type":   EdgeTypeBoundTo,
				"label":  "bound to",
			})
		}
	}

	return map[string]interface{}{
		"nodes": nodes,
		"edges": edges,
		"metadata": map[string]interface{}{
			"pv_count":  len(pvs),
			"pvc_count": len(pvcs),
		},
	}, nil
}

// selectorMatches checks if all selector key/value pairs exist in labels.
func selectorMatches(selector map[string]string, labels map[string]string) bool {
	if len(selector) == 0 {
		return false
	}
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}

// extractStringMap extracts a map[string]string from map[string]interface{} field.
func extractStringMap(m map[string]interface{}, key string) map[string]string {
	val, ok := m[key]
	if !ok || val == nil {
		return nil
	}
	switch v := val.(type) {
	case map[string]string:
		return v
	case map[string]interface{}:
		return mapStrMap(v)
	}
	return nil
}
