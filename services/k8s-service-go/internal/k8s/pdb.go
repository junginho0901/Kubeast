package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetPDBs lists PDBs in a namespace.
func (s *Service) GetPDBs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.Clientset().PolicyV1().PodDisruptionBudgets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pdbs: %w", err)
	}
	return formatPDBList(list.Items), nil
}

// GetAllPDBs lists PDBs across all namespaces.
func (s *Service) GetAllPDBs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.Clientset().PolicyV1().PodDisruptionBudgets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all pdbs: %w", err)
	}
	return formatPDBList(list.Items), nil
}

// DescribePDB returns detailed info about a PDB.
func (s *Service) DescribePDB(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var pdb *policyv1.PodDisruptionBudget
	var events *corev1.EventList
	var pdbErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pdb, pdbErr = s.Clientset().PolicyV1().PodDisruptionBudgets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.Clientset().CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=PodDisruptionBudget", name),
		})
	}()
	wg.Wait()

	if pdbErr != nil {
		return nil, fmt.Errorf("get pdb %s/%s: %w", namespace, name, pdbErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatPDBDetail(pdb)

	// Additional metadata
	result["uid"] = string(pdb.UID)
	result["resource_version"] = pdb.ResourceVersion
	result["generation"] = pdb.Generation
	result["annotations"] = pdb.Annotations
	result["labels"] = pdb.Labels

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(pdb.Status.Conditions))
	for _, c := range pdb.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                  string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Events
	eventList := make([]map[string]interface{}, 0, len(events.Items))
	for _, e := range events.Items {
		eventList = append(eventList, map[string]interface{}{
			"type":       e.Type,
			"reason":     e.Reason,
			"message":    e.Message,
			"count":      e.Count,
			"first_time": toISO(&e.FirstTimestamp),
			"last_time":  toISO(&e.LastTimestamp),
			"source":     e.Source.Component,
		})
	}
	result["events"] = eventList

	return result, nil
}

// DeletePDB deletes a PDB.
func (s *Service) DeletePDB(ctx context.Context, namespace, name string) error {
	return s.Clientset().PolicyV1().PodDisruptionBudgets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatPDBList(pdbs []policyv1.PodDisruptionBudget) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pdbs))
	for i := range pdbs {
		result = append(result, formatPDBDetail(&pdbs[i]))
	}
	return result
}

func formatPDBDetail(pdb *policyv1.PodDisruptionBudget) map[string]interface{} {
	result := map[string]interface{}{
		"name":                pdb.Name,
		"namespace":           pdb.Namespace,
		"current_healthy":     pdb.Status.CurrentHealthy,
		"desired_healthy":     pdb.Status.DesiredHealthy,
		"disruptions_allowed": pdb.Status.DisruptionsAllowed,
		"expected_pods":       pdb.Status.ExpectedPods,
		"labels":              pdb.Labels,
		"created_at":          toISO(&pdb.CreationTimestamp),
	}

	if pdb.Spec.MinAvailable != nil {
		result["min_available"] = pdb.Spec.MinAvailable.String()
	}
	if pdb.Spec.MaxUnavailable != nil {
		result["max_unavailable"] = pdb.Spec.MaxUnavailable.String()
	}

	// Selector
	selector := map[string]string{}
	if pdb.Spec.Selector != nil && pdb.Spec.Selector.MatchLabels != nil {
		selector = pdb.Spec.Selector.MatchLabels
	}
	result["selector"] = selector

	// Match expressions
	if pdb.Spec.Selector != nil && len(pdb.Spec.Selector.MatchExpressions) > 0 {
		exprs := make([]map[string]interface{}, 0, len(pdb.Spec.Selector.MatchExpressions))
		for _, e := range pdb.Spec.Selector.MatchExpressions {
			exprs = append(exprs, map[string]interface{}{
				"key":      e.Key,
				"operator": string(e.Operator),
				"values":   e.Values,
			})
		}
		result["match_expressions"] = exprs
	}

	// UnhealthyPodEvictionPolicy
	if pdb.Spec.UnhealthyPodEvictionPolicy != nil {
		result["unhealthy_pod_eviction_policy"] = string(*pdb.Spec.UnhealthyPodEvictionPolicy)
	}

	return result
}
