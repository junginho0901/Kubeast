package ws

import (
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	hparow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/hpa"
)

// hpaToInfo is the list's row (hparow.Info), so a live update says what the list says.
func hpaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var h autoscalingv2.HorizontalPodAutoscaler
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &h); err != nil {
		return genericToInfo(obj)
	}
	return hparow.Info(&h)
}
