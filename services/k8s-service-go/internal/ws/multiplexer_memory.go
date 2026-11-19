package ws

import (
	"math"
	"runtime/metrics"
	"sync"
	"time"
)

// watchMemoryShare is the share of the collector's limit (GOMEMLIMIT, which services/pkg/memlimit sets to 90 % of the
// container's) past which the memory the next collection cannot give back lets no new watch open. A watch decodes every
// object there is as it opens, which the server's opening places (defaultWatchOpeningsAtOnce) keep to what fits between
// this share and the 0.94 at which W2's 700 people ran out of memory; with their screens open they held 0.56-0.62.
const watchMemoryShare = 0.8

// memoryShortMessage is the limit frame's message for a watch that waits for memory.
const memoryShortMessage = "k8s-service is short of memory, cannot create new watch for now"

// watchMemoryFull says whether the memory held against the collector's limit is past watchMemoryShare of it. Without a
// limit (GOMEMLIMIT unset outside a container) nothing waits.
func (m *Multiplexer) watchMemoryFull() bool {
	held, limit := m.heldAndLimit()
	return limit > 0 && limit < math.MaxInt64 && float64(held) > watchMemoryShare*float64(limit)
}

// heldAndLimit is the memory held against the collector's limit and that limit (heldBytes).
func (m *Multiplexer) heldAndLimit() (held, limit uint64) {
	read := m.heap
	if read == nil {
		read = heapNow.read
	}
	return read()
}

// heapReading is the memory the next collection cannot give back and the collector's limit, read through
// runtime/metrics, which does not stop the world as runtime.ReadMemStats does, and at most once a second whatever the
// number of REQUESTs.
type heapReading struct {
	mu          sync.Mutex
	at          time.Time
	held, limit uint64
}

var heapNow heapReading

// heldSamples are what heldBytes reads.
var heldSamples = []string{
	"/gc/heap/live:bytes",
	"/gc/gomemlimit:bytes",
	"/memory/classes/total:bytes",
	"/memory/classes/heap/objects:bytes",
	"/memory/classes/heap/unused:bytes",
	"/memory/classes/heap/free:bytes",
	"/memory/classes/heap/released:bytes",
}

func (h *heapReading) read() (held, limit uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if now := time.Now(); now.Sub(h.at) >= time.Second {
		s := make([]metrics.Sample, len(heldSamples))
		for i, name := range heldSamples {
			s[i].Name = name
		}
		metrics.Read(s)
		v := make([]uint64, len(s))
		for i := range s {
			v[i] = sampleBytes(s[i])
		}
		h.held, h.limit, h.at = heldBytes(v[0], v[2], v[3], v[4], v[5], v[6]), v[1], now
	}
	return h.held, h.limit
}

// heldBytes is the heap the last collection found live and everything else the runtime holds outside the heap's objects
// and its free and returned room — goroutine stacks, the runtime's own structures —, which the collector's limit counts
// too. At 700 people of the W2 load test the stacks alone were 58-92 MiB of the 461 MiB limit, so the live heap could
// not reach three quarters of the limit before k8s-service ran out of memory.
func heldBytes(live, total, objects, unused, free, released uint64) uint64 {
	heap := objects + unused + free + released
	if total < heap {
		return live
	}
	return live + total - heap
}

func sampleBytes(s metrics.Sample) uint64 {
	if s.Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return s.Value.Uint64()
}
