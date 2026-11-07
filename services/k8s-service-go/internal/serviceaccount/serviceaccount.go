// Package serviceaccount is a ServiceAccount as Kubeast lists it, one row for the list, the drawer and the live list
// updates alike.
package serviceaccount

import (
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the ServiceAccount's row: how many token Secrets it has, the names of those and of its image pull Secrets.
func Info(sa *corev1.ServiceAccount) map[string]interface{} {
	secrets := make([]string, 0, len(sa.Secrets))
	for _, s := range sa.Secrets {
		if s.Name != "" {
			secrets = append(secrets, s.Name)
		}
	}
	pullSecrets := make([]string, 0, len(sa.ImagePullSecrets))
	for _, s := range sa.ImagePullSecrets {
		if s.Name != "" {
			pullSecrets = append(pullSecrets, s.Name)
		}
	}

	created := ""
	if !sa.CreationTimestamp.IsZero() {
		created = sa.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":               sa.Name,
		"namespace":          sa.Namespace,
		"secrets":            len(sa.Secrets),
		"secrets_list":       secrets,
		"image_pull_secrets": pullSecrets,
		"created_at":         created,
		"labels":             sa.Labels,
		"annotations":        sa.Annotations,
	}
}
