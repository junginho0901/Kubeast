package ws

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/eventtime"
	servicerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/service"
)

// namespaceToInfo — list endpoint: GetNamespaces inline (namespaces.go).
func namespaceToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata, _ := obj.Object["metadata"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	phase := ""
	if status != nil {
		if p, ok := status["phase"].(string); ok {
			phase = p
		}
	}

	return map[string]interface{}{
		"name":       metadata["name"],
		"status":     phase,
		"created_at": metadata["creationTimestamp"],
		"labels":     metadata["labels"],
	}
}

// serviceToInfo is the list's row (servicerow.Info), so a live update says what the list says.
func serviceToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var svc corev1.Service
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(withoutFieldManagers(obj), &svc); err != nil {
		return genericToInfo(obj)
	}
	return servicerow.Info(&svc)
}

// eventToInfo — list endpoint: GetEvents inline (events.go).
func eventToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata, _ := obj.Object["metadata"].(map[string]interface{})

	involved := map[string]interface{}{}
	if io, ok := obj.Object["involvedObject"].(map[string]interface{}); ok {
		// uid: a drawer keeps to the events naming its object's UID, as kubectl describe does (a Node's also its name)
		involved = map[string]interface{}{
			"kind":      io["kind"],
			"name":      io["name"],
			"namespace": io["namespace"],
			"uid":       io["uid"],
		}
	}

	source := map[string]interface{}{
		"component": nil,
		"host":      nil,
	}
	if src, ok := obj.Object["source"].(map[string]interface{}); ok {
		source["component"] = src["component"]
		source["host"] = src["host"]
	}

	reportingComponent := ""
	if rc, ok := obj.Object["reportingComponent"].(string); ok {
		reportingComponent = rc
	}

	// The times and count as the list writes them (eventtime), so an update of an events.k8s.io event does not blank them.
	var ev corev1.Event
	_ = runtime.DefaultUnstructuredConverter.FromUnstructured(slimEvent(obj), &ev)
	first, _, count := eventtime.Seen(&ev)

	return map[string]interface{}{
		"name":                metadata["name"],
		"namespace":           metadata["namespace"],
		"type":                obj.Object["type"],
		"reason":              obj.Object["reason"],
		"message":             obj.Object["message"],
		"count":               count,
		"first_timestamp":     eventtime.ISO(first),
		"last_timestamp":      eventtime.ISO(eventtime.Last(&ev)),
		"reporting_component": reportingComponent,
		"involved_object":     involved,
		"source":              source,
		"created_at":          metadata["creationTimestamp"],
	}
}

// genericToInfo — explicit *ToInfo 가 없는 fallback. metadata 만 보내면
// frontend normalize 가 status/capacity 등을 'Unknown'/null 로 fallback 처리해
// list 의 정상 데이터를 watch event 로 덮어쓰는 버그가 발생.
// raw spec/status 통째로 포함 → frontend 의 normalize 가 raw K8s 형태 처리
// 경로 (metadata.x ?? obj.x, status.phase 등) 로 정상 추출.
func genericToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata, _ := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})
	out := map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"kind":       obj.GetKind(),
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
		"spec":       spec,
		"status":     status,
	}
	// metadata 전체를 통과시키지 않으므로 ownerReferences 가 누락됨. 명시적
	// 노출 — ResourceClaimTemplate-owned RC 같은 reverse-lookup watch 시 필요.
	if ors, ok := metadata["ownerReferences"].([]interface{}); ok && len(ors) > 0 {
		refs := make([]map[string]interface{}, 0, len(ors))
		for _, r := range ors {
			rm, _ := r.(map[string]interface{})
			if rm == nil {
				continue
			}
			ctrl, _ := rm["controller"].(bool)
			refs = append(refs, map[string]interface{}{
				"kind":       rm["kind"],
				"name":       rm["name"],
				"uid":        rm["uid"],
				"controller": ctrl,
			})
		}
		out["owner_references"] = refs
	}
	return out
}
