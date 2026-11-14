// Cluster change notices (services/pkg/clusternotice). With REDIS_HOST set, tool-server listens on the channel the
// k8s-service replicas publish to when a cluster's registration changes, and drops that cluster's kubeconfigs, so a
// tool-server replica that auth-service did not call drops them at once too. It only listens: it publishes nothing and
// reads no key (the chart's Redis user tool-server allows that channel and nothing else). A notice names the cluster
// alone; the next tool call fetches the kubeconfig from k8s-service again, which checks the person's access again. A
// notice lost, or Redis down, costs at most kubeconfigTTL.
package main

import (
	"context"
	"log"
	"net"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/pkg/clusternotice"
)

// clusterNoticeClient is the Redis connection for the notices, from REDIS_HOST, REDIS_PORT, REDIS_DB, REDIS_USERNAME
// and REDIS_PASSWORD (the chart's kubeast-config and Redis user); nil without REDIS_HOST.
func clusterNoticeClient() *redis.Client {
	host := os.Getenv("REDIS_HOST")
	if host == "" {
		return nil
	}
	db, err := strconv.Atoi(envOrDefault("REDIS_DB", "0"))
	if err != nil {
		log.Printf("cluster change notices off: REDIS_DB %q is not a number", os.Getenv("REDIS_DB"))
		return nil
	}
	return redis.NewClient(&redis.Options{
		Addr:        net.JoinHostPort(host, envOrDefault("REDIS_PORT", "6379")),
		Username:    os.Getenv("REDIS_USERNAME"),
		Password:    os.Getenv("REDIS_PASSWORD"),
		DB:          db,
		DialTimeout: 5 * time.Second,
	})
}

// listenClusterNotices calls drop with the cluster of each notice until ctx ends. go-redis subscribes again after a
// lost connection; a message that is not a notice is logged by its length and skipped.
func listenClusterNotices(ctx context.Context, rdb *redis.Client, drop func(clusterID string)) {
	ps := rdb.Subscribe(ctx, clusternotice.ChannelFor(rdb.Options().DB))
	defer ps.Close()
	msgs := ps.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-msgs:
			if !ok {
				return
			}
			n, err := clusternotice.Decode(m.Payload)
			if err != nil {
				log.Printf("cluster change notice not read (%d bytes): %v", len(m.Payload), err)
				continue
			}
			drop(n.Cluster)
		}
	}
}
