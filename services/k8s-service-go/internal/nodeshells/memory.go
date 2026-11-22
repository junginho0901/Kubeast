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

// SetFail sets the answer of every call (nil: the database answers).
func (m *Memory) SetFail(err error) {
	m.mu.Lock()
	m.Fail = err
	m.mu.Unlock()
}

func (m *Memory) Insert(_ context.Context, r Row) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return m.Fail
	}
	r.OpenedAt, r.Released, r.Expired = m.now(), false, false
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
		if r := m.rows[id]; r != nil && r.Owner == owner && !r.Released {
			r.heartbeat = m.now()
			found = append(found, id)
		}
	}
	return found, nil
}

func (m *Memory) Take(_ context.Context, owner string, staleAfter, expireAfter time.Duration, skip []string, limit int) ([]Row, error) {
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
		got := r.Row // with the owner it had
		got.Expired = m.now().Sub(r.OpenedAt) > expireAfter
		out = append(out, got)
		r.Owner, r.heartbeat = owner, m.now()
	}
	return out, nil
}

func (m *Memory) Claim(_ context.Context, id, owner string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return false, m.Fail
	}
	r := m.rows[id]
	if r == nil || r.Owner != owner {
		return false, nil
	}
	r.heartbeat = m.now()
	return true, nil
}

func (m *Memory) Release(_ context.Context, id, owner string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return m.Fail
	}
	if r := m.rows[id]; r != nil && r.Owner == owner {
		r.Released = true
	}
	return nil
}

func (m *Memory) Remove(_ context.Context, id, owner string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail != nil {
		return false, m.Fail
	}
	if r := m.rows[id]; r != nil && r.Owner == owner {
		delete(m.rows, id)
		return true, nil
	}
	return false, nil
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
