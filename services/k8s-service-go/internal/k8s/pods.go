package k8s

import (
	"context"
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetPods lists pods in a namespace with optional label selector.
func (s *Service) GetPods(ctx context.Context, namespace string, labelSelector string) ([]map[string]interface{}, error) {
	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}
	podList, err := s.clientsetCtx(ctx).CoreV1().Pods(namespace).List(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	return formatPodList(podList.Items), nil
}

// GetAllPods lists pods across all namespaces.
func (s *Service) GetAllPods(ctx context.Context) ([]map[string]interface{}, error) {
	podList, err := s.clientsetCtx(ctx).CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list all pods: %w", err)
	}
	return formatPodList(podList.Items), nil
}

// DeletePod deletes a pod with optional force deletion.
func (s *Service) DeletePod(ctx context.Context, namespace, name string, force bool) error {
	opts := metav1.DeleteOptions{}
	if force {
		grace := int64(0)
		opts.GracePeriodSeconds = &grace
	}
	return s.clientsetCtx(ctx).CoreV1().Pods(namespace).Delete(ctx, name, opts)
}
