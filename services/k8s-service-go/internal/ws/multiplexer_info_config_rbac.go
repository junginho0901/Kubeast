package ws

import (
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	configmaprow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/configmap"
	rolerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/role"
	secretrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/secret"
	sarow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/serviceaccount"
)

// configmapToInfo is the list's row (configmaprow.Info), so a live update says what the list says. An object that does
// not convert stays a generic row, which has no data: a row holds no value.
func configmapToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var cm corev1.ConfigMap
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &cm); err != nil {
		return genericToInfo(obj)
	}
	return configmaprow.Info(&cm)
}

// secretToInfo is the list's row (secretrow.Info), so a live update says what the list says. An object that does not
// convert stays a generic row, which has neither the data nor the annotations: a row holds no value.
func secretToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var s corev1.Secret
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &s); err != nil {
		return genericToInfo(obj)
	}
	return secretrow.Info(&s)
}

// serviceAccountToInfo is the list's row (sarow.Info), so a live update says what the list says. An object that does
// not convert keeps its names, which sit beside the metadata and not under spec or status, for the page to read.
func serviceAccountToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var sa corev1.ServiceAccount
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &sa); err != nil {
		out := genericToInfo(obj)
		for _, field := range []string{"secrets", "imagePullSecrets"} {
			if names, ok := obj.Object[field]; ok {
				out[field] = names
			}
		}
		return out
	}
	return sarow.Info(&sa)
}

// roleToInfo is the list's row (rolerow.Info), so a live update says what the list says. An object that does not
// convert keeps its rules, which sit beside the metadata and not under spec or status, for the page to count.
func roleToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var r rbacv1.Role
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &r); err != nil {
		out := genericToInfo(obj)
		if rules, ok := obj.Object["rules"]; ok {
			out["rules"] = rules
		}
		return out
	}
	return rolerow.Info(&r)
}
