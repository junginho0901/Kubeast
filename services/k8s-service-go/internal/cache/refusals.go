package cache

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// refusalLogEvery bounds the log line that says Redis refused commands for the user's ACL: a refused read repeats on
// every request.
const refusalLogEvery = 10 * time.Second

// refusalCounts are the commands Redis refused k8s-service with NOPERM (its user's line in the chart's redis.acl), by
// command: the cache reads such a refusal as a miss and goes on, so nothing else shows it.
type refusalCounts struct {
	refused *prometheus.CounterVec
	// since is how many were refused since the last log line, nextLog when the next may be written (unix nanoseconds).
	since, nextLog atomic.Int64
}

func newRefusalCounts() *refusalCounts {
	return &refusalCounts{refused: prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "kubeast_redis_refusals_total", Help: "Redis commands refused with NOPERM for the service's Redis user (redis.acl), by command.",
		ConstLabels: prometheus.Labels{"service": "k8s"},
	}, []string{"command"})}
}

// refusals is what k8s-service's Redis clients count into.
var refusals = newRefusalCounts()

// RefusalCollectors are the Redis refusal metrics, for the service's registry.
func RefusalCollectors() []prometheus.Collector { return []prometheus.Collector{refusals.refused} }

// CountRefusals makes rdb count each command Redis refuses for its user's ACL, and returns it.
func CountRefusals(rdb *redis.Client) *redis.Client {
	rdb.AddHook(refusalHook{refusals})
	return rdb
}

type refusalHook struct{ c *refusalCounts }

func (h refusalHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h refusalHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		err := next(ctx, cmd)
		h.c.note(cmd.Name(), err)
		return err
	}
}

func (h refusalHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		err := next(ctx, cmds)
		for _, cmd := range cmds {
			h.c.note(cmd.Name(), cmd.Err())
		}
		return err
	}
}

// note counts err when it is Redis's NOPERM and says so in the log, at most once per refusalLogEvery, with the command
// and how many were refused since the last line. CLIENT is left out: only go-redis sends it, to name itself on each new
// connection, and it goes on when Redis refuses it (docs/configuration.md "Redis users").
func (c *refusalCounts) note(command string, err error) {
	var fromRedis redis.Error
	if err == nil || !errors.As(err, &fromRedis) || !strings.HasPrefix(fromRedis.Error(), "NOPERM") {
		return
	}
	command = strings.ToLower(command)
	if command == "client" {
		return
	}
	c.refused.WithLabelValues(command).Inc()
	c.since.Add(1)
	now := time.Now().UnixNano()
	next := c.nextLog.Load()
	if now < next || !c.nextLog.CompareAndSwap(next, now+int64(refusalLogEvery)) {
		return
	}
	slog.Warn("redis refused commands for this service's Redis user: add them to its line in redis.acl (the cache reads them as misses)",
		"command", command, "refused", c.since.Swap(0), "err", err)
}
