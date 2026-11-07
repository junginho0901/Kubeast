package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	schedulingv1 "k8s.io/api/scheduling/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	priorityclassrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/priorityclass"
)

// GetPriorityClasses lists all PriorityClasses.
func (s *Service) GetPriorityClasses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).SchedulingV1().PriorityClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list priorityclasses: %w", err)
	}
	return formatPriorityClassList(list.Items), nil
}

// DescribePriorityClass returns detailed info about a PriorityClass.
func (s *Service) DescribePriorityClass(ctx context.Context, name string) (map[string]interface{}, error) {
	var pc *schedulingv1.PriorityClass
	var events *corev1.EventList
	var pcErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pc, pcErr = s.clientsetCtx(ctx).SchedulingV1().PriorityClasses().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientsetCtx(ctx).CoreV1().Events("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=PriorityClass", name),
		})
	}()
	wg.Wait()

	if pcErr != nil {
		return nil, fmt.Errorf("get priorityclass %s: %w", name, pcErr)
	}
	result := priorityclassrow.Info(pc)

	// Additional metadata
	result["uid"] = string(pc.UID)
	result["resource_version"] = pc.ResourceVersion
	result["generation"] = pc.Generation
	result["annotations"] = pc.Annotations
	result["labels"] = pc.Labels

	// Events
	setEvents(result, events, eventsErr)

	return result, nil
}

// DeletePriorityClass deletes a PriorityClass.
func (s *Service) DeletePriorityClass(ctx context.Context, name string) error {
	return s.clientsetCtx(ctx).SchedulingV1().PriorityClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatPriorityClassList(pcs []schedulingv1.PriorityClass) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(pcs))
	for i := range pcs {
		result = append(result, priorityclassrow.Info(&pcs[i]))
	}
	return result
}
