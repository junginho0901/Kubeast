// Package replicaset is a ReplicaSet as Kubeast lists it, one row for the list, the drawer and the live list updates
// alike.
package replicaset

import (
	"time"

	appsv1 "k8s.io/api/apps/v1"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/replicastatus"
)

// Info is the ReplicaSet's row: its counts, containers and owners. owner_references is there with no owner too, so a
// row that lost its owner says so.
func Info(rs *appsv1.ReplicaSet) map[string]interface{} {
	replicas := int32(0)
	if rs.Spec.Replicas != nil {
		replicas = *rs.Spec.Replicas
	}

	images := make([]string, 0, len(rs.Spec.Template.Spec.Containers))
	containers := make([]string, 0, len(rs.Spec.Template.Spec.Containers))
	for _, c := range rs.Spec.Template.Spec.Containers {
		images = append(images, c.Image)
		containers = append(containers, c.Name)
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	var selector interface{}
	if rs.Spec.Selector != nil && rs.Spec.Selector.MatchLabels != nil {
		selector = rs.Spec.Selector.MatchLabels
	} else {
		selector = map[string]string{}
	}

	owner := ""
	for _, or := range rs.OwnerReferences {
		if or.Kind == "Deployment" {
			owner = or.Name
			break
		}
	}

	ownerRefs := make([]map[string]interface{}, 0, len(rs.OwnerReferences))
	for _, or := range rs.OwnerReferences {
		ownerRefs = append(ownerRefs, map[string]interface{}{
			"kind":       or.Kind,
			"name":       or.Name,
			"uid":        string(or.UID),
			"controller": or.Controller != nil && *or.Controller,
		})
	}

	created := ""
	if !rs.CreationTimestamp.IsZero() {
		created = rs.CreationTimestamp.UTC().Format(time.RFC3339)
	}

	return map[string]interface{}{
		"name":               rs.Name,
		"namespace":          rs.Namespace,
		"replicas":           replicas,
		"current_replicas":   rs.Status.Replicas,
		"ready_replicas":     rs.Status.ReadyReplicas,
		"available_replicas": rs.Status.AvailableReplicas,
		"image":              image,
		"images":             images,
		"containers":         containers,
		"selector":           selector,
		"owner_deployment":   owner,
		"owner_references":   ownerRefs,
		"status":             replicastatus.Of(replicas, rs.Status.AvailableReplicas, rs.Status.ReadyReplicas),
		"created_at":         created,
	}
}
