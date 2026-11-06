package ws

import (
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	nodev1 "k8s.io/api/node/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	schedulingv1 "k8s.io/api/scheduling/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	clusterrolerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/clusterrole"
	leaserow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/lease"
	limitrangerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/limitrange"
	pdbrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/pdb"
	priorityclassrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/priorityclass"
	resourcequotarow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/resourcequota"
	rolebindingrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/rolebinding"
	runtimeclassrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/runtimeclass"
	webhookrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/webhookconfig"
)

// listRow is the list's row of a typed object, so a live update says what the list says. An object that does not convert
// stays a generic row, with what the kind holds beside its metadata and not under spec or status, for the page to read.
func listRow[T any](obj *unstructured.Unstructured, row func(*T) map[string]interface{}, beside ...string) map[string]interface{} {
	var typed T
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &typed); err != nil {
		out := genericToInfo(obj)
		for _, field := range beside {
			if value, ok := obj.Object[field]; ok {
				out[field] = value
			}
		}
		return out
	}
	return row(&typed)
}

func clusterRoleToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[rbacv1.ClusterRole](obj, clusterrolerow.Info, "rules")
}

func clusterRoleBindingToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[rbacv1.ClusterRoleBinding](obj, rolebindingrow.Cluster, "roleRef", "subjects")
}

func roleBindingToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[rbacv1.RoleBinding](obj, rolebindingrow.Info, "roleRef", "subjects")
}

func priorityClassToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[schedulingv1.PriorityClass](obj, priorityclassrow.Info, "value", "globalDefault", "preemptionPolicy", "description")
}

func runtimeClassToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[nodev1.RuntimeClass](obj, runtimeclassrow.Info, "handler")
}

// A webhook configuration that does not convert says how many webhooks it has, as its row does, not what each is given.
func webhookConfigToInfo[T any](obj *unstructured.Unstructured, row func(*T) map[string]interface{}) map[string]interface{} {
	out := listRow[T](obj, row)
	if _, isRow := out["webhooks_count"]; !isRow {
		webhooks, _ := obj.Object["webhooks"].([]interface{})
		out["webhooks_count"] = len(webhooks)
	}
	return out
}

func validatingWebhookConfigToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return webhookConfigToInfo[admissionregistrationv1.ValidatingWebhookConfiguration](obj, webhookrow.Validating)
}

func mutatingWebhookConfigToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return webhookConfigToInfo[admissionregistrationv1.MutatingWebhookConfiguration](obj, webhookrow.Mutating)
}

func leaseToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[coordinationv1.Lease](obj, leaserow.Info)
}

func limitRangeToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[corev1.LimitRange](obj, limitrangerow.Info)
}

func resourceQuotaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[corev1.ResourceQuota](obj, resourcequotarow.Info)
}

func pdbToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return listRow[policyv1.PodDisruptionBudget](obj, pdbrow.Info)
}
