package k8s

import (
	"context"
	"fmt"
	"strings"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"gopkg.in/yaml.v3"
)

// GetNamespaces returns all namespaces.
func (s *Service) GetNamespaces(ctx context.Context) ([]map[string]interface{}, error) {
	nsList, err := s.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(nsList.Items))
	for _, ns := range nsList.Items {
		result = append(result, map[string]interface{}{
			"name":       ns.Name,
			"status":     string(ns.Status.Phase),
			"created_at": toISO(&ns.CreationTimestamp),
			"labels":     ns.Labels,
		})
	}
	return result, nil
}

// DescribeNamespace returns detailed info about a namespace.
func (s *Service) DescribeNamespace(ctx context.Context, name string) (map[string]interface{}, error) {
	// Fetch all data in parallel using WaitGroup
	var ns *corev1.Namespace
	var events *corev1.EventList
	var quotas *corev1.ResourceQuotaList
	var limits *corev1.LimitRangeList
	var nsErr, eventsErr, quotasErr, limitsErr error
	podCount, svcCount, depCount, cmCount, secretCount := 0, 0, 0, 0, 0

	var wg sync.WaitGroup
	wg.Add(9)
	go func() {
		defer wg.Done()
		ns, nsErr = s.clientset.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		if pods, err := s.clientset.CoreV1().Pods(name).List(ctx, metav1.ListOptions{}); err == nil {
			podCount = len(pods.Items)
		}
	}()
	go func() {
		defer wg.Done()
		if svcs, err := s.clientset.CoreV1().Services(name).List(ctx, metav1.ListOptions{}); err == nil {
			svcCount = len(svcs.Items)
		}
	}()
	go func() {
		defer wg.Done()
		if deps, err := s.clientset.AppsV1().Deployments(name).List(ctx, metav1.ListOptions{}); err == nil {
			depCount = len(deps.Items)
		}
	}()
	go func() {
		defer wg.Done()
		if cms, err := s.clientset.CoreV1().ConfigMaps(name).List(ctx, metav1.ListOptions{}); err == nil {
			cmCount = len(cms.Items)
		}
	}()
	go func() {
		defer wg.Done()
		if secrets, err := s.clientset.CoreV1().Secrets(name).List(ctx, metav1.ListOptions{}); err == nil {
			secretCount = len(secrets.Items)
		}
	}()
	go func() {
		defer wg.Done()
		quotas, quotasErr = s.clientset.CoreV1().ResourceQuotas(name).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		limits, limitsErr = s.clientset.CoreV1().LimitRanges(name).List(ctx, metav1.ListOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(name).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Namespace", name),
		})
	}()
	wg.Wait()

	if nsErr != nil {
		return nil, fmt.Errorf("get namespace %s: %w", name, nsErr)
	}

	quotaList := make([]map[string]interface{}, 0)
	if quotasErr == nil && quotas != nil {
		quotaList = buildQuotaList(quotas.Items)
	}
	limitList := make([]map[string]interface{}, 0)
	if limitsErr == nil && limits != nil {
		limitList = buildLimitRangeList(limits.Items)
	}

	res := map[string]interface{}{
		"name":             ns.Name,
		"status":           string(ns.Status.Phase),
		"labels":           ns.Labels,
		"annotations":      ns.Annotations,
		"created_at":       toISO(&ns.CreationTimestamp),
		"uid":              string(ns.UID),
		"resource_version": ns.ResourceVersion,
		"finalizers":       ns.Finalizers,
		"resource_counts": map[string]int{
			"pods":        podCount,
			"services":    svcCount,
			"deployments": depCount,
			"configmaps":  cmCount,
			"secrets":     secretCount,
		},
		"resource_quotas": quotaList,
		"limit_ranges":    limitList,
	}

	// Deletion timestamp
	if ns.DeletionTimestamp != nil {
		res["deletion_timestamp"] = toISO(ns.DeletionTimestamp)
	}

	// Owner references
	owners := make([]map[string]interface{}, 0, len(ns.OwnerReferences))
	for _, or := range ns.OwnerReferences {
		owner := map[string]interface{}{
			"kind": or.Kind,
			"name": or.Name,
			"uid":  string(or.UID),
		}
		if or.Controller != nil && *or.Controller {
			owner["controller"] = true
		}
		owners = append(owners, owner)
	}
	res["owner_references"] = owners

	// Conditions
	conditions := make([]map[string]interface{}, 0, len(ns.Status.Conditions))
	for _, c := range ns.Status.Conditions {
		conditions = append(conditions, map[string]interface{}{
			"type":                  string(c.Type),
			"status":               string(c.Status),
			"reason":               c.Reason,
			"message":              c.Message,
			"last_transition_time": toISO(&c.LastTransitionTime),
		})
	}
	res["conditions"] = conditions

	// Events
	if eventsErr == nil && events != nil {
		sortEventsByTime(events.Items)
		res["events"] = formatEventList(events.Items)
	}

	return res, nil
}

// GetNamespaceYAML returns namespace manifest as YAML.
func (s *Service) GetNamespaceYAML(ctx context.Context, name string, forceRefresh bool) (string, error) {
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "namespaces"}
	return s.GetResourceYAML(ctx, gvr, "", name, forceRefresh)
}

// CreateNamespace creates a new namespace.
func (s *Service) CreateNamespace(ctx context.Context, name string, labels map[string]string) (map[string]interface{}, error) {
	ns := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name:   name,
			Labels: labels,
		},
	}
	created, err := s.clientset.CoreV1().Namespaces().Create(ctx, ns, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("create namespace %s: %w", name, err)
	}
	return map[string]interface{}{
		"name":       created.Name,
		"status":     string(created.Status.Phase),
		"created_at": toISO(&created.CreationTimestamp),
		"labels":     created.Labels,
	}, nil
}

// DeleteNamespace deletes a namespace.
func (s *Service) DeleteNamespace(ctx context.Context, name string) error {
	return s.clientset.CoreV1().Namespaces().Delete(ctx, name, metav1.DeleteOptions{})
}

// GetNamespaceResourceQuotas lists resource quotas in a namespace.
func (s *Service) GetNamespaceResourceQuotas(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	quotas, err := s.clientset.CoreV1().ResourceQuotas(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list resource quotas: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(quotas.Items))
	for _, q := range quotas.Items {
		hard := make(map[string]string)
		used := make(map[string]string)
		for k, v := range q.Status.Hard {
			hard[string(k)] = v.String()
		}
		for k, v := range q.Status.Used {
			used[string(k)] = v.String()
		}
		result = append(result, map[string]interface{}{
			"name":       q.Name,
			"namespace":  q.Namespace,
			"hard":       hard,
			"used":       used,
			"created_at": toISO(&q.CreationTimestamp),
		})
	}
	return result, nil
}

// GetNamespaceLimitRanges lists limit ranges in a namespace.
func (s *Service) GetNamespaceLimitRanges(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	limits, err := s.clientset.CoreV1().LimitRanges(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list limit ranges: %w", err)
	}

	result := make([]map[string]interface{}, 0, len(limits.Items))
	for _, l := range limits.Items {
		items := buildLimitItems(l.Spec.Limits)
		result = append(result, map[string]interface{}{
			"name":       l.Name,
			"namespace":  l.Namespace,
			"limits":     items,
			"created_at": toISO(&l.CreationTimestamp),
		})
	}
	return result, nil
}

// GetNamespaceOwnedPods lists pods in a namespace.
func (s *Service) GetNamespaceOwnedPods(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	pods, err := s.clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list pods in %s: %w", namespace, err)
	}

	result := make([]map[string]interface{}, 0, len(pods.Items))
	for _, p := range pods.Items {
		ready := 0
		total := len(p.Spec.Containers)
		restarts := int32(0)
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Ready {
				ready++
			}
			restarts += cs.RestartCount
		}
		result = append(result, map[string]interface{}{
			"name":          p.Name,
			"namespace":     p.Namespace,
			"status":        string(p.Status.Phase),
			"ready":         fmt.Sprintf("%d/%d", ready, total),
			"restart_count": restarts,
			"restarts":      restarts,
			"node_name":     p.Spec.NodeName,
			"node":          p.Spec.NodeName,
			"created_at":    toISO(&p.CreationTimestamp),
		})
	}
	return result, nil
}

// ApplyNamespaceYAML applies labels/annotations from a YAML string to a namespace.
// Protected keys with kubernetes.io/ and metadata.k8s.io/ prefixes are not modified.
func (s *Service) ApplyNamespaceYAML(ctx context.Context, name string, yamlStr string) (map[string]interface{}, error) {
	ns, err := s.clientset.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("get namespace %s: %w", name, err)
	}

	var parsed map[string]interface{}
	if err := yaml.Unmarshal([]byte(yamlStr), &parsed); err != nil {
		return nil, fmt.Errorf("parse YAML: %w", err)
	}

	metadata, ok := parsed["metadata"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("invalid YAML: missing metadata")
	}

	if newLabels, ok := metadata["labels"].(map[string]interface{}); ok {
		if ns.Labels == nil {
			ns.Labels = make(map[string]string)
		}
		for k, v := range newLabels {
			if isProtectedKey(k) {
				continue
			}
			ns.Labels[k] = fmt.Sprintf("%v", v)
		}
	}

	if newAnnotations, ok := metadata["annotations"].(map[string]interface{}); ok {
		if ns.Annotations == nil {
			ns.Annotations = make(map[string]string)
		}
		for k, v := range newAnnotations {
			if isProtectedKey(k) {
				continue
			}
			ns.Annotations[k] = fmt.Sprintf("%v", v)
		}
	}

	updated, err := s.clientset.CoreV1().Namespaces().Update(ctx, ns, metav1.UpdateOptions{})
	if err != nil {
		return nil, fmt.Errorf("update namespace %s: %w", name, err)
	}

	s.cache.Delete(ctx, fmt.Sprintf("yaml|namespaces||%s", name))

	return map[string]interface{}{
		"name":        updated.Name,
		"status":      string(updated.Status.Phase),
		"labels":      updated.Labels,
		"annotations": updated.Annotations,
		"created_at":  toISO(&updated.CreationTimestamp),
	}, nil
}

// isProtectedKey checks if a label/annotation key is protected from modification.
func isProtectedKey(key string) bool {
	return strings.Contains(key, "kubernetes.io/") || strings.Contains(key, "metadata.k8s.io/")
}

// buildQuotaList converts resource quotas to map representation.
func buildQuotaList(items []corev1.ResourceQuota) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, q := range items {
		hard := make(map[string]string)
		used := make(map[string]string)
		for k, v := range q.Status.Hard {
			hard[string(k)] = v.String()
		}
		for k, v := range q.Status.Used {
			used[string(k)] = v.String()
		}
		result = append(result, map[string]interface{}{
			"name": q.Name,
			"hard": hard,
			"used": used,
		})
	}
	return result
}

// buildLimitRangeList converts limit ranges to map representation.
func buildLimitRangeList(items []corev1.LimitRange) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, l := range items {
		result = append(result, map[string]interface{}{
			"name":   l.Name,
			"limits": buildLimitItems(l.Spec.Limits),
		})
	}
	return result
}

// buildLimitItems converts limit range items to map representation.
func buildLimitItems(items []corev1.LimitRangeItem) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for _, li := range items {
		item := map[string]interface{}{
			"type": string(li.Type),
		}
		if li.Max != nil {
			m := make(map[string]string)
			for k, v := range li.Max {
				m[string(k)] = v.String()
			}
			item["max"] = m
		}
		if li.Min != nil {
			m := make(map[string]string)
			for k, v := range li.Min {
				m[string(k)] = v.String()
			}
			item["min"] = m
		}
		if li.Default != nil {
			m := make(map[string]string)
			for k, v := range li.Default {
				m[string(k)] = v.String()
			}
			item["default"] = m
		}
		if li.DefaultRequest != nil {
			m := make(map[string]string)
			for k, v := range li.DefaultRequest {
				m[string(k)] = v.String()
			}
			item["default_request"] = m
		}
		result = append(result, item)
	}
	return result
}
