package nodeshells

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Memory is a Store held in memory with its own clock, for tests: several
// Trackers sharing one Memory are servers sharing one database.
type Memory struct {
	mu   sync.Mutex
	now  func() time.Time
	rows map[string]*memRow
	// Fail, when set, is every call's answer: the database is down.
	Fail error
}

type memRow struct {
	Row
	heartbeat time.Time
}

// NewMemory makes an empty store; now is its clock (time.Now when nil).
func NewMemory(now func() time.Time) *Memory {
	if now == nil {
		now = time.Now
	}
	return &Memory{now: now, rows: map[string]*memRow{}}
}

func (m *Memory) Insert(_ context.Context, r Row) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return m.Fail
	}
	r.OpenedAt = m.now()
	m.rows[r.ID] = &memRow{Row: r, heartbeat: r.OpenedAt}
	return nil
}

func (m *Memory) Beat(_ context.Context, owner string, ids []string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return nil, m.Fail
	}
	var found []string
	for _, id := range ids {
		if r := m.rows[id]; r != nil && r.Owner == owner {
			r.heartbeat = m.now()
			found = append(found, id)
		}
	}
	return found, nil
}

func (m *Memory) Take(_ context.Context, owner string, staleAfter time.Duration, skip []string, limit int) ([]Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return nil, m.Fail
	}
	skipped := map[string]bool{}
	for _, id := range skip {
		skipped[id] = true
	}
	var stale []*memRow
	for _, r := range m.rows {
		if !skipped[r.ID] && m.now().Sub(r.heartbeat) > staleAfter {
			stale = append(stale, r)
		}
	}
	sort.Slice(stale, func(i, j int) bool { return stale[i].heartbeat.Before(stale[j].heartbeat) })
	var out []Row
	for _, r := range stale {
		if len(out) == limit {
			break
		}
		out = append(out, r.Row) // with the owner it had
		r.Owner, r.heartbeat = owner, m.now()
	}
	return out, nil
}

func (m *Memory) Remove(_ context.Context, id, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return m.Fail
	}
	if r := m.rows[id]; r != nil && r.Owner == owner {
		delete(m.rows, id)
	}
	return nil
}

func (m *Memory) Ping(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.Fail
}

// Rows returns the stored rows by id (tests).
func (m *Memory) Rows() map[string]Row {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]Row, len(m.rows))
	for id, r := range m.rows {
		out[id] = r.Row
	}
	return out
}
