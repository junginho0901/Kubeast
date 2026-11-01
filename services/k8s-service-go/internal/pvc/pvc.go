// Package pvc is a PersistentVolumeClaim as Kubeast lists it, one row for the list, the drawer and the live list
// updates alike.
package pvc

import (
	"time"

	corev1 "k8s.io/api/core/v1"
)

// Info is the claim's row. Capacity and access modes are the volume's, once the claim is bound to one, as kubectl's
// printPersistentVolumeClaim (v1.37) prints them; requested and requested_access_modes are what the claim asks for.
func Info(c *corev1.PersistentVolumeClaim) map[string]interface{} {
	capacity := ""
	accessModes := make([]string, 0, len(c.Status.AccessModes))
	if c.Spec.VolumeName != "" {
		if q, ok := c.Status.Capacity[corev1.ResourceStorage]; ok {
			capacity = q.String()
		}
		for _, am := range c.Status.AccessModes {
			accessModes = append(accessModes, string(am))
		}
	}
	requested := ""
	if q, ok := c.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		requested = q.String()
	}
	requestedModes := make([]string, 0, len(c.Spec.AccessModes))
	for _, am := range c.Spec.AccessModes {
		requestedModes = append(requestedModes, string(am))
	}
	storageClass := ""
	if c.Spec.StorageClassName != nil {
		storageClass = *c.Spec.StorageClassName
	}
	created := ""
	if !c.CreationTimestamp.IsZero() {
		created = c.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	return map[string]interface{}{
		"name":                   c.Name,
		"namespace":              c.Namespace,
		"status":                 string(c.Status.Phase),
		"volume_name":            c.Spec.VolumeName,
		"capacity":               capacity,
		"requested":              requested,
		"access_modes":           accessModes,
		"requested_access_modes": requestedModes,
		"storage_class":          storageClass,
		"created_at":             created,
	}
}
