package ws

import (
	"math"
	"runtime/metrics"
	"sync"
	"time"
)

// watchMemoryShare is the share of the collector's limit (GOMEMLIMIT, which services/pkg/memlimit sets to 90 % of the
// container's) past which the live heap lets no new watch open. A watch decodes every object there is as it opens: in
// TestWSMemoryPerUser 700 people reopening their screens at once held 640 KiB more each while the first objects came
// in, and opening the node list of 1 000 nodes 4.3-5.1 MiB each; on 512 Mi that burst ended k8s-service six times in a
// row in the W2 load test, each restart bringing every watch back at once.
const watchMemoryShare = 0.75

// watchMemoryFull says whether the heap the last collection found live is past watchMemoryShare of the collector's
// limit. Without a limit (GOMEMLIMIT unset outside a container) nothing waits.
func (m *Multiplexer) watchMemoryFull() bool {
	read := m.heap
	if read == nil {
		read = heapNow.read
	}
	live, limit := read()
	return limit > 0 && limit < math.MaxInt64 && float64(live) > watchMemoryShare*float64(limit)
}

// heapReading is the live heap and the collector's limit, read through runtime/metrics, which does not stop the world as
// runtime.ReadMemStats does, and at most once a second whatever the number of REQUESTs.
type heapReading struct {
	mu          sync.Mutex
	at          time.Time
	live, limit uint64
}

var heapNow heapReading

func (h *heapReading) read() (live, limit uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if now := time.Now(); now.Sub(h.at) >= time.Second {
		s := []metrics.Sample{{Name: "/gc/heap/live:bytes"}, {Name: "/gc/gomemlimit:bytes"}}
		metrics.Read(s)
		h.live, h.limit, h.at = sampleBytes(s[0]), sampleBytes(s[1]), now
	}
	return h.live, h.limit
}

func sampleBytes(s metrics.Sample) uint64 {
	if s.Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return s.Value.Uint64()
}
