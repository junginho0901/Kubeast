package main

import "testing"

// docs/architecture.md, the upgrade notes and the live lists' memory gate (watchMemoryShare, 0.8 of the collector's
// limit: 348 MiB) count from k8s-service's 85 %, 435 MiB of the chart's 512 Mi.
func TestTheCollectorGets85PercentOfTheChartsLimit(t *testing.T) {
	chart := int64(512) << 20
	if got := int64(float64(chart) * k8sMemoryLimitShare); got != 456340275 {
		t.Fatalf("the collector's limit at the chart's 512 Mi is %d bytes, want 456340275 (85 %%, 435 MiB)", got)
	}
}
