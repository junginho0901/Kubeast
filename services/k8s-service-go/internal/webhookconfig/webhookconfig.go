// Package webhookconfig is a Validating or Mutating webhook configuration as Kubeast lists it, one row for the list, the
// drawer and the live list updates alike. The row counts the webhooks: what each is given stays in the drawer's answer.
package webhookconfig

import (
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Validating is a ValidatingWebhookConfiguration's row.
func Validating(c *admissionregistrationv1.ValidatingWebhookConfiguration) map[string]interface{} {
	return row(&c.ObjectMeta, len(c.Webhooks))
}

// Mutating is a MutatingWebhookConfiguration's row.
func Mutating(c *admissionregistrationv1.MutatingWebhookConfiguration) map[string]interface{} {
	return row(&c.ObjectMeta, len(c.Webhooks))
}

func row(meta *metav1.ObjectMeta, webhooks int) map[string]interface{} {
	created := ""
	if !meta.CreationTimestamp.IsZero() {
		created = meta.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":           meta.Name,
		"webhooks_count": webhooks,
		"labels":         meta.Labels,
		"created_at":     created,
	}
}
