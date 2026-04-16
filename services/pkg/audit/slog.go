package audit

import (
	"context"
	"log/slog"
	"sync/atomic"
)

// SlogStore is a fallback Writer that emits records to the structured
// logger. Useful when Postgres is unavailable (local development, CI) or
// while Postgres is being migrated.
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

	attrs := []any{
		"audit_id", id,
		"service", rec.Service,
		"action", rec.Action,
		"result", rec.Result,
		"actor", rec.ActorEmail,
		"target_type", rec.TargetType,
		"target", rec.TargetID,
		"namespace", rec.Namespace,
		"cluster", rec.Cluster,
		"path", rec.Path,
		"ip", rec.RequestIP,
		"request_id", rec.RequestID,
	}
	if rec.Result == ResultFailure && rec.Error != "" {
		attrs = append(attrs, "error", rec.Error)
	}
	slog.InfoContext(ctx, "audit", attrs...)
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
