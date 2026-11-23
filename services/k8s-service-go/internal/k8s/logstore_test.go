package k8s

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// The clusters List gives with a log store URL are the searcher's own-store clusters, as main.go wires them, so
// features.logSearch.clusters (ClusterIDs, which the log search screen reads) lists one the chart's map leaves out.
func TestLogStoreClustersPutAListedOwnStoreInTheLogSearchFeature(t *testing.T) {
	s := &Service{registry: &mockRegistry{clusters: map[cluster.ID]cluster.Info{
		"own":   {ID: "own", Mode: cluster.ModeExternal, LogSearchURL: "http://loki.example:3100"},
		"blank": {ID: "blank", Mode: cluster.ModeExternal, LogSearchURL: "  "},
		"plain": extCluster("plain"),
	}}}
	searcher, err := logsearch.New(logsearch.Config{
		Enabled: true, Backend: "loki", URL: "http://loki.global:3100",
		Labels:       logsearch.Labels{Cluster: "k8s_cluster_name", Namespace: "k8s_namespace_name", Pod: "k8s_pod_name", Container: "k8s_container_name"},
		Clusters:     map[string]string{"self": "kubeast"},
		DefaultRange: time.Hour, MaxRange: 24 * time.Hour, MaxLines: 100, Timeout: time.Second, PerUserPerMinute: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	searcher.OwnStoreClusters = s.LogStoreClusters
	if got := searcher.ClusterIDs(context.Background()); strings.Join(got, ",") != "own,self" {
		t.Fatalf("log search clusters %v, want own (its own store) and self (the chart's map)", got)
	}
}
