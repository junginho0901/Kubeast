package metrics

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakePool is a pool's statistics as pgxpool's Stat gives them.
type fakePool struct {
	acquired, idle, constructing, max int32
	empty, canceled                   int64
	emptyWait                         time.Duration
}

func (p fakePool) AcquiredConns() int32                { return p.acquired }
func (p fakePool) IdleConns() int32                    { return p.idle }
func (p fakePool) ConstructingConns() int32            { return p.constructing }
func (p fakePool) MaxConns() int32                     { return p.max }
func (p fakePool) EmptyAcquireCount() int64            { return p.empty }
func (p fakePool) EmptyAcquireWaitTime() time.Duration { return p.emptyWait }
func (p fakePool) CanceledAcquireCount() int64         { return p.canceled }

// The pool is read once per scrape and shown under the service's label only: connections by state, the most it may
// hold, and the takes that found no idle connection (how many, how long they waited) or gave up.
func TestDBPoolIsReadOncePerScrape(t *testing.T) {
	m := New("k8s")
	var reads atomic.Int32
	m.DBPool(func() PoolStat {
		reads.Add(1)
		return fakePool{acquired: 7, idle: 2, constructing: 1, max: 10, empty: 42, emptyWait: 1500 * time.Millisecond, canceled: 3}
	})
	body := scrape(t, m)
	for _, want := range []string{
		`kubeast_db_pool_connections{service="k8s",state="in_use"} 7`,
		`kubeast_db_pool_connections{service="k8s",state="idle"} 2`,
		`kubeast_db_pool_connections{service="k8s",state="opening"} 1`,
		`kubeast_db_pool_max_connections{service="k8s"} 10`,
		`kubeast_db_pool_empty_acquires_total{service="k8s"} 42`,
		`kubeast_db_pool_empty_acquire_wait_seconds_total{service="k8s"} 1.5`,
		`kubeast_db_pool_canceled_acquires_total{service="k8s"} 3`,
		"# TYPE kubeast_db_pool_connections gauge",
		"# TYPE kubeast_db_pool_empty_acquires_total counter",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("scrape lacks %q:\n%s", want, body)
		}
	}
	if n := reads.Load(); n != 1 {
		t.Fatalf("the pool was read %d times for one scrape, want 1", n)
	}
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "kubeast_db_pool_") && strings.Count(line, "=") > 2 {
			t.Fatalf("a pool series with more labels than service and state: %s", line)
		}
	}
}
