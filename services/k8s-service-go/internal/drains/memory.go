package drains

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
	now := m.now()
	r.StartedAt, r.UpdatedAt, r.FinishedAt = now, now, nil
	m.rows[r.ID] = &memRow{Row: r, heartbeat: now}
	return nil
}

func (m *Memory) open(id, owner string) *memRow {
	r := m.rows[id]
	if r == nil || r.Owner != owner || r.FinishedAt != nil {
		return nil
	}
	return r
}

func (m *Memory) Progress(_ context.Context, id, owner string, p Progress) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.open(id, owner)
	if r == nil {
		return false, nil
	}
	if p.Status != "" {
		r.Status = p.Status
	}
	if p.Message != nil {
		r.Message = *p.Message
	}
	if p.PodsTotal != nil {
		v := *p.PodsTotal
		r.PodsTotal = &v
	}
	if p.PodsDone != nil {
		v := *p.PodsDone
		r.PodsDone = &v
	}
	r.UpdatedAt = m.now()
	return true, nil
}

func (m *Memory) Finish(_ context.Context, id, owner, status, message string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.open(id, owner)
	if r == nil {
		return false, nil
	}
	m.end(r, status, message)
	return true, nil
}

func (m *Memory) end(r *memRow, status, message string) {
	now := m.now()
	r.Status, r.Message, r.FinishedAt, r.UpdatedAt = status, message, &now, now
}

func (m *Memory) stale(r *memRow, staleAfter time.Duration) bool {
	return r.FinishedAt == nil && m.now().Sub(r.heartbeat) > staleAfter
}

func (m *Memory) Get(_ context.Context, id string, staleAfter time.Duration) (*Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[id]
	if r == nil {
		return nil, nil
	}
	out := r.Row
	out.Stale = m.stale(r, staleAfter)
	return &out, nil
}

func (m *Memory) Beat(_ context.Context, owner string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	for id, r := range m.rows {
		if r.Owner == owner && r.FinishedAt == nil {
			r.heartbeat = m.now()
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

func (m *Memory) Interrupt(_ context.Context, id string, staleAfter time.Duration, message string) ([]Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Row
	for _, r := range m.rows {
		if (id == "" || r.ID == id) && m.stale(r, staleAfter) {
			m.end(r, StatusInterrupted, message)
			out = append(out, r.Row)
		}
	}
	return out, nil
}

func (m *Memory) HandOver(_ context.Context, owner, message string) ([]Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Row
	for _, r := range m.rows {
		if r.Owner == owner && r.FinishedAt == nil {
			m.end(r, StatusInterrupted, message)
			out = append(out, r.Row)
		}
	}
	return out, nil
}

func (m *Memory) Purge(_ context.Context, keep time.Duration, batch int) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for id, r := range m.rows {
		if n >= int64(batch) {
			break
		}
		if r.FinishedAt != nil && m.now().Sub(*r.FinishedAt) > keep {
			delete(m.rows, id)
			n++
		}
	}
	return n, nil
}

func (m *Memory) Ping(context.Context) error { return nil }
