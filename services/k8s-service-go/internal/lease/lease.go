// Package lease is a Lease as Kubeast lists it, one row for the list, the drawer and the live list updates alike.
package lease

import (
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
)

// Info is the Lease's row: its holder and times, each only where the object has it.
func Info(l *coordinationv1.Lease) map[string]interface{} {
	created := ""
	if !l.CreationTimestamp.IsZero() {
		created = l.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	result := map[string]interface{}{
		"name":       l.Name,
		"namespace":  l.Namespace,
		"labels":     l.Labels,
		"created_at": created,
	}

	if l.Spec.HolderIdentity != nil {
		result["holder_identity"] = *l.Spec.HolderIdentity
	}
	if l.Spec.LeaseDurationSeconds != nil {
		result["lease_duration_seconds"] = *l.Spec.LeaseDurationSeconds
	}
	if l.Spec.LeaseTransitions != nil {
		result["lease_transitions"] = *l.Spec.LeaseTransitions
	}
	// in UTC: a decoded MicroTime is in the process's local zone, which the literal "Z" used to mislabel
	if l.Spec.RenewTime != nil {
		result["renew_time"] = l.Spec.RenewTime.UTC().Format(time.RFC3339)
	}
	if l.Spec.AcquireTime != nil {
		result["acquire_time"] = l.Spec.AcquireTime.UTC().Format(time.RFC3339)
	}

	return result
}
