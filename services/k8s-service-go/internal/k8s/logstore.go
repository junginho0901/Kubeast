package k8s

import (
	"context"
	"log/slog"
	"strings"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logsearch"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
)

// logStoreFromInfo reads the log store a cluster names for itself; nil when
// it names none (the deployment-wide store applies).
func logStoreFromInfo(info cluster.Info) *logsearch.Store {
	u := strings.TrimRight(strings.TrimSpace(info.LogSearchURL), "/")
	if u == "" {
		return nil
	}
	return &logsearch.Store{URL: u, AuthHeader: info.LogSearchAuthHeader, Tenant: strings.TrimSpace(info.LogSearchTenant), ClusterLabel: strings.TrimSpace(info.LogSearchClusterLabel)}
}

// LogStore returns the log store cluster id names for itself, nil for none
// or an unknown cluster. It lives on the cluster's bundle, so a registration
// change (which invalidates the bundle) takes effect on the next search.
func (s *Service) LogStore(ctx context.Context, id string) *logsearch.Store {
	b, err := s.For(ctx, cluster.ID(id))
	if err != nil {
		return nil
	}
	return b.logStore
}

// LogStoreClusters lists the registered clusters that name their own log
// store (features.logSearch.clusters lists the rest).
func (s *Service) LogStoreClusters(ctx context.Context) []string {
	infos, err := s.registry.List(ctx)
	if err != nil {
		slog.Warn("log store clusters: registry list failed", "err", err)
		return nil
	}
	var ids []string
	for _, info := range infos {
		if strings.TrimSpace(info.LogSearchURL) != "" {
			ids = append(ids, string(info.ID))
		}
	}
	return ids
}
