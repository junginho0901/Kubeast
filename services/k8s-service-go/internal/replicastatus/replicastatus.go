// Package replicastatus is the summary status of a workload that counts replicas, for the lists, their drawers and the
// Resource Graph alike.
package replicastatus

// Of is a StatefulSet's, DaemonSet's or ReplicaSet's status: Idle with none wanted, Unavailable with none available,
// Degraded with fewer ready than wanted, else Healthy.
func Of(want, available, ready int32) string {
	switch {
	case want == 0:
		return "Idle"
	case available == 0:
		return "Unavailable"
	case ready < want:
		return "Degraded"
	}
	return "Healthy"
}
