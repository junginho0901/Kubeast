package ws

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// objectToInfo dispatcher — per-resource-kind ToInfo helpers live in sibling
// files (multiplexer_info_*.go). Each helper is a pure function from an
// unstructured K8s object to a frontend-shaped info map. This file stays
// focused on the dispatch so multiplexer.go can keep its WebSocket /
// subscription / watch loop concerns separate.
//
// IMPORTANT: 각 *ToInfo 의 반환 keys 는 internal/k8s 의 list endpoint
// (formatXxxDetail / inline list 코드) 와 **반드시 동일** 해야 한다.
// 두 응답이 frontend cache 에서 같은 queryKey 를 공유하므로 watch
// event 가 list 의 정상 항목을 부분 데이터로 덮어쓰면 새로고침 시
// statefulset/deployment 등에서 데이터 사라짐 / 일부만 표시 회귀 발생.

// objectToInfo converts an unstructured K8s object to a simplified info map.
func objectToInfo(resource string, obj *unstructured.Unstructured) map[string]interface{} {
	switch resource {
	case "pods":
		return podToInfo(obj)
	case "nodes":
		return nodeToInfo(obj)
	case "namespaces":
		return namespaceToInfo(obj)
	case "services":
		return serviceToInfo(obj)
	case "events":
		return eventToInfo(obj)
	case "deployments":
		return deploymentToInfo(obj)
	case "persistentvolumeclaims":
		return pvcToInfo(obj)
	case "persistentvolumes":
		return pvToInfo(obj)
	case "storageclasses":
		return storageclassToInfo(obj)
	case "statefulsets":
		return statefulsetToInfo(obj)
	case "daemonsets":
		return daemonsetToInfo(obj)
	case "replicasets":
		return replicasetToInfo(obj)
	case "jobs":
		return jobToInfo(obj)
	case "cronjobs":
		return cronjobToInfo(obj)
	case "ingresses":
		return ingressToInfo(obj)
	case "configmaps":
		return configmapToInfo(obj)
	case "secrets":
		return secretToInfo(obj)
	case "serviceaccounts":
		return serviceAccountToInfo(obj)
	case "roles":
		return roleToInfo(obj)
	case "horizontalpodautoscalers":
		return hpaToInfo(obj)
	case "verticalpodautoscalers":
		return vpaToInfo(obj)
	default:
		// Generic: return metadata + spec summary
		return genericToInfo(obj)
	}
}
