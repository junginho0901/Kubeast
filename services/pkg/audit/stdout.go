package audit

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
)

// StdoutEnabled reports whether audit records are also written to the process
// log (AUDIT_STDOUT, default true). The cluster's log pipeline picks the lines
// up like any other container output, so a record survives outside the app DB.
func StdoutEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("AUDIT_STDOUT")))
	return v != "false" && v != "0" && v != "off"
}

// StdoutTee wraps a Store and emits every record as one JSON line on the
// structured logger: msg "audit", top-level "event": "audit", and the record
// under "audit". The line is written whether or not the inner write succeeded;
// a failed inner write carries store_error and the returned error is unchanged.
type StdoutTee struct {
	Store
	log *slog.Logger
}

// WithStdout wraps store in a StdoutTee when enabled; otherwise returns store.
func WithStdout(store Store, enabled bool) Store {
	if !enabled {
		return store
	}
	return &StdoutTee{Store: store, log: slog.Default()}
}

// Write persists through the inner Store and logs the record.
func (t *StdoutTee) Write(ctx context.Context, rec Record) (int64, error) {
	id, err := t.Store.Write(ctx, rec)
	attrs := recordAttrs(rec, id)
	if err != nil {
		attrs = append(attrs, "store_error", err.Error())
	}
	t.log.InfoContext(ctx, "audit", "event", "audit", slog.Group("audit", attrs...))
	return id, err
}

// recordAttrs is the single definition of the audit log line's fields, shared
// by StdoutTee and SlogStore. before/after are included only when they hold
// valid JSON (they are masked by the caller before reaching the store).
func recordAttrs(rec Record, id int64) []any {
	if rec.Result == "" {
		rec.Result = ResultSuccess
	}
	attrs := []any{
		"id", id,
		"service", rec.Service,
		"action", rec.Action,
		"result", rec.Result,
		"actor_user_id", rec.ActorUserID,
		"actor_email", rec.ActorEmail,
		"target_type", rec.TargetType,
		"target_id", rec.TargetID,
		"target_email", rec.TargetEmail,
		"cluster", rec.Cluster,
		"namespace", rec.Namespace,
		"path", rec.Path,
		"request_ip", rec.RequestIP,
		"user_agent", rec.UserAgent,
		"request_id", rec.RequestID,
	}
	if rec.Result == ResultFailure && rec.Error != "" {
		attrs = append(attrs, "error", rec.Error)
	}
	if len(rec.Before) > 0 && json.Valid(rec.Before) {
		attrs = append(attrs, "before", rec.Before)
	}
	if len(rec.After) > 0 && json.Valid(rec.After) {
		attrs = append(attrs, "after", rec.After)
	}
	return attrs
}
