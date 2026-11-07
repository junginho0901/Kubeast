package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	pdbrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/pdb"
)

// GetPDBs lists PDBs in a namespace.
func (s *Service) GetPDBs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).PolicyV1().PodDisruptionBudgets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pdbs: %w", err)
	}
	return formatPDBList(list.Items), nil
}

// GetAllPDBs lists PDBs across all namespaces.
func (s *Service) GetAllPDBs(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		list, err := s.clientsetCtx(ctx).PolicyV1().PodDisruptionBudgets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, fmt.Errorf("list all pdbs: %w", err)
		}
		return formatPDBList(list.Items), nil
	})
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
		pdb, pdbErr = s.clientsetCtx(ctx).PolicyV1().PodDisruptionBudgets(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=PodDisruptionBudget", name),
		})
	}()
	wg.Wait()

	if pdbErr != nil {
		return nil, fmt.Errorf("get pdb %s/%s: %w", namespace, name, pdbErr)
	}
	result := pdbrow.Info(pdb)

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
			"type":                 string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	result["conditions"] = conditions

	// Events
	setEvents(result, events, eventsErr)

	return result, nil
}

// DeletePDB deletes a PDB.
func (s *Service) DeletePDB(ctx context.Context, namespace, name string) error {
	return s.clientsetCtx(ctx).PolicyV1().PodDisruptionBudgets(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatPDBList(pdbs []policyv1.PodDisruptionBudget) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pdbs))
	for i := range pdbs {
		result = append(result, pdbrow.Info(&pdbs[i]))
	}
	return result
}
