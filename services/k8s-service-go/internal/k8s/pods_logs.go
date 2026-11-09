package k8s

import (
	"context"
	"fmt"
	"io"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GetPodLogs returns logs for a pod container.
func (s *Service) GetPodLogs(ctx context.Context, namespace, name, container string, tailLines int64) (string, error) {
	opts := &corev1.PodLogOptions{}
	if container != "" {
		opts.Container = container
	}
	if tailLines > 0 {
		opts.TailLines = &tailLines
	}

	req := s.clientsetCtx(ctx).CoreV1().Pods(namespace).GetLogs(name, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return "", fmt.Errorf("get pod logs %s/%s: %w", namespace, name, err)
	}
	defer stream.Close()

	data, err := io.ReadAll(stream)
	if err != nil {
		return "", fmt.Errorf("read pod logs: %w", err)
	}
	return string(data), nil
}

// StreamPodLogs returns a streaming io.ReadCloser for follow-mode pod logs.
// A non-zero since reads every line from that second on (the kubelet takes whole seconds).
func (s *Service) StreamPodLogs(ctx context.Context, namespace, name, container string, tailLines int64, since time.Time) (io.ReadCloser, error) {
	opts := &corev1.PodLogOptions{
		Follow:     true,
		Timestamps: true,
	}
	if container != "" {
		opts.Container = container
	}
	if tailLines > 0 {
		opts.TailLines = &tailLines
	}
	if !since.IsZero() {
		t := metav1.NewTime(since)
		opts.SinceTime = &t
	}

	req := s.clientsetCtx(ctx).CoreV1().Pods(namespace).GetLogs(name, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return nil, fmt.Errorf("stream pod logs %s/%s: %w", namespace, name, err)
	}
	return stream, nil
}
