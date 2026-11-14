package k8s

import (
	"context"
	"fmt"
	"sync"

	corev1 "k8s.io/api/core/v1"
	nodev1 "k8s.io/api/node/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	runtimeclassrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/runtimeclass"
)

// GetRuntimeClasses lists all RuntimeClasses.
func (s *Service) GetRuntimeClasses(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.clientsetCtx(ctx).NodeV1().RuntimeClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list runtimeclasses: %w", err)
	}
	return formatRuntimeClassList(list.Items), nil
}

// DescribeRuntimeClass returns detailed info about a RuntimeClass.
func (s *Service) DescribeRuntimeClass(ctx context.Context, name string) (map[string]interface{}, error) {
	var rc *nodev1.RuntimeClass
	var events *corev1.EventList
	var rcErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		rc, rcErr = s.clientsetCtx(ctx).NodeV1().RuntimeClasses().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.objectEvents(ctx, "", "RuntimeClass", name)
	}()
	wg.Wait()

	if rcErr != nil {
		return nil, fmt.Errorf("get runtimeclass %s: %w", name, rcErr)
	}
	result := runtimeclassrow.Info(rc)

	// Additional metadata
	result["uid"] = string(rc.UID)
	result["resource_version"] = rc.ResourceVersion
	result["generation"] = rc.Generation
	result["annotations"] = rc.Annotations
	result["labels"] = rc.Labels

	// Events
	setEvents(result, events, eventsErr, about(rc.UID))

	return result, nil
}

// DeleteRuntimeClass deletes a RuntimeClass.
func (s *Service) DeleteRuntimeClass(ctx context.Context, name string) error {
	return s.clientsetCtx(ctx).NodeV1().RuntimeClasses().Delete(ctx, name, metav1.DeleteOptions{})
}

func formatRuntimeClassList(rcs []nodev1.RuntimeClass) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(rcs))
	for i := range rcs {
		result = append(result, runtimeclassrow.Info(&rcs[i]))
	}
	return result
}
