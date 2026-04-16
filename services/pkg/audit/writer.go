package audit

import "context"

// Writer persists audit records.
//
// Implementations must be safe for concurrent use. Writes are best-effort —
// failures are logged by the caller but never block or error the business
// operation (see docs/audit-log-plan.md §2 D4).
type Writer interface {
	// Write persists a Record and returns the assigned DB id.
	// A zero id with a non-nil error indicates total failure; callers should
	// log the error and continue with the original request.
	Write(ctx context.Context, rec Record) (int64, error)
}

// Reader retrieves audit records for UI/admin consumption.
type Reader interface {
	// List returns matching entries plus the total row count (for pagination).
	List(ctx context.Context, filter Filter) (entries []Entry, total int, err error)

	// Get fetches a single entry by id; returns (nil, nil) when not found.
	Get(ctx context.Context, id int64) (*Entry, error)
}

// Store combines Writer and Reader.
type Store interface {
	Writer
	Reader
}
