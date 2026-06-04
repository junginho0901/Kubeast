package k8s

import (
	"context"
	"fmt"
	"sync"
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
