// Package daemonset is a DaemonSet as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package daemonset

import (
	"time"

	appsv1 "k8s.io/api/apps/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicastatus"
)

// Info is the DaemonSet's row: its counts, images, node selector and the status replicastatus reads from them.
func Info(ds *appsv1.DaemonSet) map[string]interface{} {
	images := make([]string, 0, len(ds.Spec.Template.Spec.Containers))
	for _, c := range ds.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	var selector interface{}
	if ds.Spec.Selector != nil && ds.Spec.Selector.MatchLabels != nil {
		selector = ds.Spec.Selector.MatchLabels
	} else {
		selector = map[string]string{}
	}

	created := ""
	if !ds.CreationTimestamp.IsZero() {
		created = ds.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":          ds.Name,
		"namespace":     ds.Namespace,
		"desired":       ds.Status.DesiredNumberScheduled,
		"current":       ds.Status.CurrentNumberScheduled,
		"ready":         ds.Status.NumberReady,
		"updated":       ds.Status.UpdatedNumberScheduled,
		"available":     ds.Status.NumberAvailable,
		"misscheduled":  ds.Status.NumberMisscheduled,
		"unavailable":   ds.Status.NumberUnavailable,
		"node_selector": ds.Spec.Template.Spec.NodeSelector,
		"image":         image,
		"images":        images,
		"selector":      selector,
		"status":        replicastatus.Of(ds.Status.DesiredNumberScheduled, ds.Status.NumberAvailable, ds.Status.NumberReady),
		"created_at":    created,
	}
}
