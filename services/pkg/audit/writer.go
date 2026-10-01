package audit

import "context"

// Writer persists audit records.
//
// Implementations must be safe for concurrent use. The stdout mirror is
// best-effort, the database row is not: a sensitive action checks Readier
// before it runs and treats a failed Write as a reason not to answer
// (docs/audit-log-plan.md §2 D4). Mutations that already happened keep their
// response — the failure is counted and logged by Guarded.
type Writer interface {
	// Write persists a Record and returns the assigned DB id.
	// A zero id with a non-nil error indicates the row was not stored.
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
