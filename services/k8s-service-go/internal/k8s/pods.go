package k8s

import (
	"context"
	"encoding/json"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetPods lists pods in a namespace with optional label selector, a page at a time: only the rows stay, not the
// pods (a namespace of 50 000 pods as one list took k8s-service past 512 Mi).
func (s *Service) GetPods(ctx context.Context, namespace string, labelSelector string) ([]map[string]interface{}, error) {
	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}
	rows := make([]map[string]interface{}, 0)
	if err := eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), namespace, opts, func(p *corev1.Pod) { rows = append(rows, formatPodDetail(p)) }); err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	return rows, nil
}

// GetPodsJSON is GetPods' rows as response.JSON writes them, each row kept as its JSON: rows held as maps took 8.3 times the answer.
func (s *Service) GetPodsJSON(ctx context.Context, namespace string, labelSelector string) ([]byte, error) {
	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}
	out := []byte{'['}
	var rowErr error
	err := eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), namespace, opts, func(p *corev1.Pod) {
		if rowErr != nil {
			return
		}
		row, err := json.Marshal(formatPodDetail(p))
		if err != nil {
			rowErr = err
			return
		}
		if len(out) > 1 {
			out = append(out, ',')
		}
		out = append(out, row...)
	})
	if err == nil {
		err = rowErr
	}
	if err != nil {
		return nil, fmt.Errorf("list pods: %w", err)
	}
	return append(out, ']', '\n'), nil
}

// GetAllPods lists pods across all namespaces, a page at a time as GetPods.
func (s *Service) GetAllPods(ctx context.Context) ([]map[string]interface{}, error) {
	return s.listAcrossNamespaces(ctx, func(ns string) ([]map[string]interface{}, error) {
		rows := make([]map[string]interface{}, 0)
		if err := eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), ns, metav1.ListOptions{}, func(p *corev1.Pod) { rows = append(rows, formatPodDetail(p)) }); err != nil {
			return nil, fmt.Errorf("list all pods: %w", err)
		}
		return rows, nil
	})
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
