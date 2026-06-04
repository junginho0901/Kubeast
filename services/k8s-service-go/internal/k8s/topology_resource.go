package k8s

import (
	"context"
	"fmt"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

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
