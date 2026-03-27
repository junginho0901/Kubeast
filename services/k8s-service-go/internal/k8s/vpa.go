package k8s

import (
	"context"
	"fmt"
	"strings"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// isVPANotInstalled checks if the error indicates VPA CRD is not installed.
func isVPANotInstalled(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "the server could not find the requested resource") ||
		strings.Contains(msg, "no matches for kind") ||
		strings.Contains(msg, "could not find the requested resource")
}

var vpaGVR = schema.GroupVersionResource{
	Group:    "autoscaling.k8s.io",
	Version:  "v1",
	Resource: "verticalpodautoscalers",
}

// GetVPAs lists VPAs in a namespace using dynamic client.
func (s *Service) GetVPAs(ctx context.Context, namespace string) ([]map[string]interface{}, error) {
	list, err := s.dynamic.Resource(vpaGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		if isVPANotInstalled(err) {
			return []map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("list vpas: %w", err)
	}
	return formatVPAList(list.Items), nil
}

// GetAllVPAs lists VPAs across all namespaces.
func (s *Service) GetAllVPAs(ctx context.Context) ([]map[string]interface{}, error) {
	list, err := s.dynamic.Resource(vpaGVR).Namespace("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isVPANotInstalled(err) {
			return []map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("list all vpas: %w", err)
	}
	return formatVPAList(list.Items), nil
}

// DescribeVPA returns detailed info about a VPA.
func (s *Service) DescribeVPA(ctx context.Context, namespace, name string) (map[string]interface{}, error) {
	var vpa *unstructured.Unstructured
	var events *corev1.EventList
	var vpaErr, eventsErr error

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		vpa, vpaErr = s.dynamic.Resource(vpaGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	}()
	go func() {
		defer wg.Done()
		events, eventsErr = s.clientset.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=VerticalPodAutoscaler", name),
		})
	}()
	wg.Wait()

	if vpaErr != nil {
		return nil, fmt.Errorf("get vpa %s/%s: %w", namespace, name, vpaErr)
	}
	if eventsErr != nil {
		events = &corev1.EventList{}
	}
	sortEventsByTime(events.Items)

	result := formatVPADetailFromUnstructured(vpa)

	// Additional metadata
	result["uid"] = string(vpa.GetUID())
	result["resource_version"] = vpa.GetResourceVersion()
	result["generation"] = vpa.GetGeneration()
	result["annotations"] = vpa.GetAnnotations()

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

// DeleteVPA deletes a VPA.
func (s *Service) DeleteVPA(ctx context.Context, namespace, name string) error {
	return s.dynamic.Resource(vpaGVR).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

func formatVPAList(items []unstructured.Unstructured) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(items))
	for i := range items {
		result = append(result, formatVPADetailFromUnstructured(&items[i]))
	}
	return result
}

func formatVPADetailFromUnstructured(obj *unstructured.Unstructured) map[string]interface{} {
	spec := mapMap(obj.Object, "spec")
	status := mapMap(obj.Object, "status")

	// Target ref
	targetRef := mapMap(spec, "targetRef")
	targetRefStr := ""
	targetRefKind := ""
	targetRefName := ""
	if targetRef != nil {
		targetRefKind = mapStr(targetRef, "kind")
		targetRefName = mapStr(targetRef, "name")
		targetRefStr = fmt.Sprintf("%s/%s", targetRefKind, targetRefName)
	}

	// Update policy
	updatePolicy := mapMap(spec, "updatePolicy")
	updateMode := ""
	if updatePolicy != nil {
		updateMode = mapStr(updatePolicy, "updateMode")
	}

	// Resource policy - container policies
	resourcePolicy := mapMap(spec, "resourcePolicy")
	var containerPolicies []map[string]interface{}
	if resourcePolicy != nil {
		if policies := mapSlice(resourcePolicy, "containerPolicies"); len(policies) > 0 {
			containerPolicies = make([]map[string]interface{}, 0, len(policies))
			for _, p := range policies {
				pm, ok := p.(map[string]interface{})
				if !ok {
					continue
				}
				cp := map[string]interface{}{
					"container_name": mapStr(pm, "containerName"),
					"mode":           mapStr(pm, "mode"),
				}
				if cr := mapSliceStr(pm, "controlledResources"); len(cr) > 0 {
					cp["controlled_resources"] = cr
				}
				if cv := mapStr(pm, "controlledValues"); cv != "" {
					cp["controlled_values"] = cv
				}
				if minAllowed := mapMap(pm, "minAllowed"); minAllowed != nil {
					cp["min_allowed"] = minAllowed
				}
				if maxAllowed := mapMap(pm, "maxAllowed"); maxAllowed != nil {
					cp["max_allowed"] = maxAllowed
				}
				containerPolicies = append(containerPolicies, cp)
			}
		}
	}

	// Status conditions
	var conditions []map[string]interface{}
	if statusConditions := mapSlice(status, "conditions"); len(statusConditions) > 0 {
		conditions = make([]map[string]interface{}, 0, len(statusConditions))
		for _, c := range statusConditions {
			cm, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			conditions = append(conditions, map[string]interface{}{
				"type":                 mapStr(cm, "type"),
				"status":              mapStr(cm, "status"),
				"reason":              mapStr(cm, "reason"),
				"message":             mapStr(cm, "message"),
				"last_transition_time": mapStr(cm, "lastTransitionTime"),
			})
		}
	}

	// Recommendations
	var recommendations []map[string]interface{}
	if recommendation := mapMap(status, "recommendation"); recommendation != nil {
		if containerRecs := mapSlice(recommendation, "containerRecommendations"); len(containerRecs) > 0 {
			recommendations = make([]map[string]interface{}, 0, len(containerRecs))
			for _, r := range containerRecs {
				rm, ok := r.(map[string]interface{})
				if !ok {
					continue
				}
				rec := map[string]interface{}{
					"container_name": mapStr(rm, "containerName"),
				}
				if target := mapMap(rm, "target"); target != nil {
					rec["target"] = target
				}
				if lower := mapMap(rm, "lowerBound"); lower != nil {
					rec["lower_bound"] = lower
				}
				if upper := mapMap(rm, "upperBound"); upper != nil {
					rec["upper_bound"] = upper
				}
				if uncapped := mapMap(rm, "uncappedTarget"); uncapped != nil {
					rec["uncapped_target"] = uncapped
				}
				recommendations = append(recommendations, rec)
			}
		}
	}

	// Extract CPU/Memory from first recommendation for list display
	cpuTarget := ""
	memoryTarget := ""
	if len(recommendations) > 0 {
		if target, ok := recommendations[0]["target"].(map[string]interface{}); ok {
			if cpu, ok := target["cpu"].(string); ok {
				cpuTarget = cpu
			}
			if mem, ok := target["memory"].(string); ok {
				memoryTarget = mem
			}
		}
	}

	// Provided status
	provided := ""
	if len(conditions) > 0 {
		provided = conditions[0]["status"].(string)
	}

	result := map[string]interface{}{
		"name":               obj.GetName(),
		"namespace":          obj.GetNamespace(),
		"target_ref":         targetRefStr,
		"target_ref_kind":    targetRefKind,
		"target_ref_name":    targetRefName,
		"update_mode":        updateMode,
		"container_policies": containerPolicies,
		"conditions":         conditions,
		"recommendations":    recommendations,
		"cpu_target":         cpuTarget,
		"memory_target":      memoryTarget,
		"provided":           provided,
		"labels":             obj.GetLabels(),
		"created_at":         toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	return result
}

// mapSliceStr extracts a []string from a map field.
func mapSliceStr(m map[string]interface{}, key string) []string {
	v, ok := m[key]
	if !ok {
		return nil
	}
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	result := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}
