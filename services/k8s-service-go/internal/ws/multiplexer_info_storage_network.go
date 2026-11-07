package ws

import (
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	ingressrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/ingress"
	ingressclassrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/ingressclass"
	netpolrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/networkpolicy"
	pvrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/pv"
	pvcrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/pvc"
	scrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/storageclass"
	varow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/volumeattachment"
)

// pvcToInfo is the list's row (pvcrow.Info), so a live update says what the list says.
func pvcToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var c corev1.PersistentVolumeClaim
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &c); err != nil {
		return genericToInfo(obj)
	}
	return pvcrow.Info(&c)
}

// pvToInfo is the list's row (pvrow.Info), so a live update says what the list says.
func pvToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var pv corev1.PersistentVolume
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &pv); err != nil {
		return genericToInfo(obj)
	}
	return pvrow.Info(&pv)
}

// storageclassToInfo is the list's row (scrow.Info), so a live update says what the list says.
func storageclassToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var sc storagev1.StorageClass
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &sc); err != nil {
		return genericToInfo(obj)
	}
	return scrow.Info(&sc)
}

// volumeAttachmentToInfo is the list's row (varow.Info), so a live update says what the list says.
func volumeAttachmentToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var va storagev1.VolumeAttachment
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &va); err != nil {
		return genericToInfo(obj)
	}
	return varow.Info(&va)
}

// ingressToInfo is the list's row (ingressrow.Info), so a live update says what the list says.
func ingressToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var ing networkingv1.Ingress
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &ing); err != nil {
		return genericToInfo(obj)
	}
	return ingressrow.Info(&ing)
}

// ingressClassToInfo is the list's row (ingressclassrow.Info), so a live update says what the list says.
func ingressClassToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var ic networkingv1.IngressClass
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &ic); err != nil {
		return genericToInfo(obj)
	}
	return ingressclassrow.Info(&ic)
}

// networkPolicyToInfo is the list's row (netpolrow.Info), so a live update says what the list says.
func networkPolicyToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var np networkingv1.NetworkPolicy
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &np); err != nil {
		return genericToInfo(obj)
	}
	return netpolrow.Info(&np)
}
