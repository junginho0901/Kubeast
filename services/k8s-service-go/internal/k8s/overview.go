package k8s

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetClusterOverview returns a high-level summary of the cluster state (cached 30s).
func (s *Service) GetClusterOverview(ctx context.Context) (map[string]interface{}, error) {
	cacheKey := "cluster_overview"
	var cached map[string]interface{}
	if s.cache.Get(ctx, cacheKey, &cached) {
		return cached, nil
	}

	result, err := s.getClusterOverviewUncached(ctx)
	if err != nil {
		return nil, err
	}
	s.cache.Set(ctx, cacheKey, result, 30*time.Second)
	return result, nil
}

func (s *Service) getClusterOverviewUncached(ctx context.Context) (map[string]interface{}, error) {
	nsList, err := s.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}

	podList, err := s.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}

	svcList, err := s.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list services: %w", err)
	}

	depList, err := s.clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list deployments: %w", err)
	}

	pvcList, err := s.clientset.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvcs: %w", err)
	}

	pvList, err := s.clientset.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pvs: %w", err)
	}

	nodeList, err := s.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list nodes: %w", err)
	}

	podStatus := map[string]int{
		"Running":   0,
		"Pending":   0,
		"Failed":    0,
		"Succeeded": 0,
		"Unknown":   0,
	}
	for _, p := range podList.Items {
		switch p.Status.Phase {
		case "Running":
			podStatus["Running"]++
		case "Pending":
			podStatus["Pending"]++
		case "Failed":
			podStatus["Failed"]++
		case "Succeeded":
			podStatus["Succeeded"]++
		default:
			podStatus["Unknown"]++
		}
	}

	clusterVersion := ""
	sv, err := s.clientset.Discovery().ServerVersion()
	if err == nil {
		clusterVersion = sv.GitVersion
	}

	return map[string]interface{}{
		"total_namespaces":  len(nsList.Items),
		"total_pods":        len(podList.Items),
		"total_services":    len(svcList.Items),
		"total_deployments": len(depList.Items),
		"total_pvcs":        len(pvcList.Items),
		"total_pvs":         len(pvList.Items),
		"pod_status":        podStatus,
		"node_count":        len(nodeList.Items),
		"cluster_version":   clusterVersion,
	}, nil
}

// GetComponentStatuses returns Kubernetes component statuses.
// Deprecated since K8s 1.19+ - returns empty list for newer clusters.
func (s *Service) GetComponentStatuses(ctx context.Context) ([]map[string]interface{}, error) {
	csList, err := s.clientset.CoreV1().ComponentStatuses().List(ctx, metav1.ListOptions{})
	if err != nil {
		slog.Warn("componentstatuses not available (deprecated since K8s 1.19+)", "err", err)
		return []map[string]interface{}{}, nil
	}

	result := make([]map[string]interface{}, 0, len(csList.Items))
	for _, cs := range csList.Items {
		conditions := make([]map[string]interface{}, 0, len(cs.Conditions))
		for _, c := range cs.Conditions {
			conditions = append(conditions, map[string]interface{}{
				"type":    string(c.Type),
				"status":  string(c.Status),
				"message": c.Message,
				"error":   c.Error,
			})
		}
		result = append(result, map[string]interface{}{
			"name":       cs.Name,
			"conditions": conditions,
		})
	}
	return result, nil
}
