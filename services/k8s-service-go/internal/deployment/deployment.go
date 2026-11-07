// Package deployment is a Deployment as Kubeast lists it, one row for the list, the drawer and the live list updates
// alike.
package deployment

import (
	"time"

	appsv1 "k8s.io/api/apps/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/deploystatus"
)

// Info is the Deployment's row: its counts, images, and the status and reason deploystatus reads from its conditions.
func Info(d *appsv1.Deployment) map[string]interface{} {
	replicas := int32(0)
	if d.Spec.Replicas != nil {
		replicas = *d.Spec.Replicas
	}

	images := make([]string, 0, len(d.Spec.Template.Spec.Containers))
	for _, c := range d.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	status, progressingReason := deploystatus.Of(d)

	var selector interface{}
	if d.Spec.Selector != nil && d.Spec.Selector.MatchLabels != nil {
		selector = d.Spec.Selector.MatchLabels
	} else {
		selector = map[string]string{}
	}

	created := ""
	if !d.CreationTimestamp.IsZero() {
		created = d.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":                 d.Name,
		"namespace":            d.Namespace,
		"replicas":             replicas,
		"ready_replicas":       d.Status.ReadyReplicas,
		"available_replicas":   d.Status.AvailableReplicas,
		"updated_replicas":     d.Status.UpdatedReplicas,
		"unavailable_replicas": d.Status.UnavailableReplicas,
		"progressing_reason":   progressingReason,
		"image":                image,
		"images":               images,
		"labels":               d.Labels,
		"selector":             selector,
		"status":               status,
		"created_at":           created,
	}
}
