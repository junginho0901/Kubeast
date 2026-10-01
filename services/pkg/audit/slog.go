package audit

import (
	"context"
	"log/slog"
	"sync/atomic"
)

// SlogStore is a Writer that emits records to the structured logger only.
// Services no longer fall back to it when Postgres is unavailable (they wait
// at boot and refuse sensitive actions at runtime — see Guarded); it remains
// for tests and tools that have no database.
//
// It is NOT a Reader — List/Get always return an empty result.
type SlogStore struct {
	service string
	counter atomic.Int64 // synthetic id for returned values
}

// NewSlogStore creates a logger-backed audit store.
func NewSlogStore(defaultService string) *SlogStore {
	return &SlogStore{service: defaultService}
}

// Write logs the record at INFO level and returns a synthetic id (not a DB row id).
func (s *SlogStore) Write(ctx context.Context, rec Record) (int64, error) {
	if rec.Service == "" {
		rec.Service = s.service
	}
	if rec.Result == "" {
		rec.Result = ResultSuccess
	}
	id := s.counter.Add(1)

	// Same line shape as StdoutTee (recordAttrs) so the log pipeline treats
	// both paths alike.
	slog.InfoContext(ctx, "audit", "event", "audit", slog.Group("audit", recordAttrs(rec, id)...))
	return id, nil
}

// List always returns (nil, 0, nil) — slog-backed stores cannot be queried.
func (s *SlogStore) List(ctx context.Context, f Filter) ([]Entry, int, error) {
	return nil, 0, nil
}

// Get always returns (nil, nil) — slog-backed stores cannot be queried.
func (s *SlogStore) Get(ctx context.Context, id int64) (*Entry, error) {
	return nil, nil
}
