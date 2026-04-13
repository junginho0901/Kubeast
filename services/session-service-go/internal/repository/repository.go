package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/junginho0901/kubeast/services/session-service-go/internal/model"
)

// Repository handles all database operations for sessions.
type Repository struct {
	pool *pgxpool.Pool
}

// New creates a new Repository.
func New(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

// InitSchema creates tables if they don't exist.
func (r *Repository) InitSchema(ctx context.Context) error {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS sessions (
			id VARCHAR PRIMARY KEY,
			user_id VARCHAR NOT NULL DEFAULT 'default',
			title VARCHAR NOT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS messages (
			id SERIAL PRIMARY KEY,
			session_id VARCHAR NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			role VARCHAR NOT NULL,
			content TEXT NOT NULL,
			tool_calls JSONB,
			created_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS session_contexts (
			id SERIAL PRIMARY KEY,
			session_id VARCHAR NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
			state JSONB NOT NULL DEFAULT '{}',
			cache JSONB NOT NULL DEFAULT '{}',
			updated_at TIMESTAMP NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`,
	}

	for _, q := range queries {
		if _, err := r.pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("init schema: %w", err)
		}
	}
	return nil
}

// CreateSession creates a new session and its context.
func (r *Repository) CreateSession(ctx context.Context, id, userID, title string) (*model.Session, error) {
	now := time.Now().UTC()

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	_, err = tx.Exec(ctx,
		`INSERT INTO sessions (id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
		id, userID, title, now, now,
	)
	if err != nil {
		return nil, err
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO session_contexts (session_id, state, cache, updated_at) VALUES ($1, '{}', '{}', $2)`,
		id, now,
	)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return &model.Session{
		ID:        id,
		UserID:    userID,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

// GetSession retrieves a session by ID.
func (r *Repository) GetSession(ctx context.Context, id string) (*model.Session, error) {
	var s model.Session
	err := r.pool.QueryRow(ctx,
		`SELECT id, user_id, title, created_at, updated_at FROM sessions WHERE id = $1`, id,
	).Scan(&s.ID, &s.UserID, &s.Title, &s.CreatedAt, &s.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ListSessionsWithMessageCounts returns sessions with message counts for a user.
func (r *Repository) ListSessionsWithMessageCounts(
	ctx context.Context,
	userID string,
	limit, offset int,
	beforeUpdatedAt *time.Time,
	beforeID *string,
) ([]model.Session, error) {
	var args []interface{}
	argIdx := 1

	query := `SELECT s.id, s.user_id, s.title, s.created_at, s.updated_at, COUNT(m.id) as message_count
		FROM sessions s
		LEFT JOIN messages m ON m.session_id = s.id
		WHERE s.user_id = $1`
	args = append(args, userID)
	argIdx++

	if beforeUpdatedAt != nil {
		if beforeID != nil {
			query += fmt.Sprintf(` AND (s.updated_at < $%d OR (s.updated_at = $%d AND s.id < $%d))`,
				argIdx, argIdx, argIdx+1)
			args = append(args, *beforeUpdatedAt, *beforeID)
			argIdx += 2
		} else {
			query += fmt.Sprintf(` AND s.updated_at < $%d`, argIdx)
			args = append(args, *beforeUpdatedAt)
			argIdx++
		}
	}

	query += ` GROUP BY s.id ORDER BY s.updated_at DESC, s.id DESC`
	query += fmt.Sprintf(` LIMIT $%d`, argIdx)
	args = append(args, limit)
	argIdx++

	if beforeUpdatedAt == nil {
		query += fmt.Sprintf(` OFFSET $%d`, argIdx)
		args = append(args, offset)
	}

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []model.Session
	for rows.Next() {
		var s model.Session
		if err := rows.Scan(&s.ID, &s.UserID, &s.Title, &s.CreatedAt, &s.UpdatedAt, &s.MessageCount); err != nil {
			return nil, err
		}
		sessions = append(sessions, s)
	}

	if sessions == nil {
		sessions = []model.Session{}
	}
	return sessions, rows.Err()
}

// UpdateSessionTitle updates the title and updated_at of a session.
func (r *Repository) UpdateSessionTitle(ctx context.Context, id, title string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE sessions SET title = $1, updated_at = $2 WHERE id = $3`,
		title, time.Now().UTC(), id,
	)
	return err
}

// DeleteSession deletes a session and its related messages and context.
// Explicitly deletes children first for compatibility with tables created
// by SQLAlchemy ORM (which may lack ON DELETE CASCADE at the DB level).
func (r *Repository) DeleteSession(ctx context.Context, id string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM session_contexts WHERE session_id = $1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM messages WHERE session_id = $1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

// GetMessages retrieves messages for a session, ordered chronologically.
func (r *Repository) GetMessages(ctx context.Context, sessionID string, limit int) ([]model.Message, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT id, session_id, role, content, tool_calls, created_at
		FROM messages
		WHERE session_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT $2`, sessionID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []model.Message
	for rows.Next() {
		var m model.Message
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &m.ToolCalls, &m.CreatedAt); err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}

	// Reverse to get chronological order (matching Python behavior)
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	if messages == nil {
		messages = []model.Message{}
	}
	return messages, rows.Err()
}

// AddMessage adds a message and updates the session's updated_at.
func (r *Repository) AddMessage(ctx context.Context, sessionID, role, content string, toolCalls *json.RawMessage) (*model.Message, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()

	var m model.Message
	err = tx.QueryRow(ctx,
		`INSERT INTO messages (session_id, role, content, tool_calls, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, session_id, role, content, tool_calls, created_at`,
		sessionID, role, content, toolCalls, now,
	).Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &m.ToolCalls, &m.CreatedAt)
	if err != nil {
		return nil, err
	}

	_, err = tx.Exec(ctx, `UPDATE sessions SET updated_at = $1 WHERE id = $2`, now, sessionID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return &m, nil
}

// GetMessageCount returns the number of messages in a session.
func (r *Repository) GetMessageCount(ctx context.Context, sessionID string) (int, error) {
	var count int
	err := r.pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM messages WHERE session_id = $1`, sessionID,
	).Scan(&count)
	return count, err
}
