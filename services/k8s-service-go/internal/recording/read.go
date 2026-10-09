package recording

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Recording is one row of session_recordings as the console lists it.
type Recording struct {
	ID            string     `json:"id"`
	Kind          string     `json:"kind"`
	UserID        *string    `json:"user_id,omitempty"`
	UserEmail     *string    `json:"user_email,omitempty"`
	Cluster       string     `json:"cluster"`
	Namespace     *string    `json:"namespace,omitempty"`
	Target        string     `json:"target"`
	Container     *string    `json:"container,omitempty"`
	Storage       string     `json:"storage"`
	StartedAt     time.Time  `json:"started_at"`
	EndedAt       *time.Time `json:"ended_at,omitempty"`
	Bytes         int64      `json:"bytes"`
	UploadedBytes int64      `json:"uploaded_bytes"`
	Parts         int        `json:"parts"`
	Status        string     `json:"status"`
	Truncated     bool       `json:"truncated"`
	LastError     *string    `json:"last_error,omitempty"`
	location      string
}

// ErrNotFound: no recording with that id.
var ErrNotFound = errors.New("recording not found")

const recordingColumns = `id, kind, user_id, user_email, cluster, namespace, target, container, storage, started_at, ended_at, bytes, uploaded_bytes, parts, status, truncated, last_error, location`

func scanRecording(row pgx.Row) (*Recording, error) {
	var r Recording
	if err := row.Scan(&r.ID, &r.Kind, &r.UserID, &r.UserEmail, &r.Cluster, &r.Namespace, &r.Target, &r.Container, &r.Storage,
		&r.StartedAt, &r.EndedAt, &r.Bytes, &r.UploadedBytes, &r.Parts, &r.Status, &r.Truncated, &r.LastError, &r.location); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &r, nil
}

// Filter narrows List.
type Filter struct {
	User    string // email substring
	Cluster string
	Kind    string
	Limit   int
	Offset  int // rows to skip, for paging
}

// List returns recordings, newest first. It works whether or not recording
// is on now (rows from before stay readable).
func (m *Manager) List(ctx context.Context, f Filter) ([]Recording, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 200
	}
	if f.Offset < 0 {
		f.Offset = 0
	}
	rows, err := m.pool.Query(ctx, `SELECT `+recordingColumns+` FROM session_recordings
		WHERE ($1 = '' OR user_email ILIKE '%' || $1 || '%') AND ($2 = '' OR cluster = $2) AND ($3 = '' OR kind = $3)
		ORDER BY started_at DESC, id LIMIT $4 OFFSET $5`, f.User, f.Cluster, f.Kind, f.Limit, f.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Recording{}
	for rows.Next() {
		r, err := scanRecording(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (m *Manager) Get(ctx context.Context, id string) (*Recording, error) {
	return scanRecording(m.pool.QueryRow(ctx, `SELECT `+recordingColumns+` FROM session_recordings WHERE id = $1`, id))
}

// Cast returns the uploaded asciicast (the parts in order). A recording still
// running returns what has been uploaded so far.
func (m *Manager) Cast(ctx context.Context, r *Recording) ([]byte, error) {
	st := m.store
	if st == nil || storeKind(st) != r.Storage {
		// Recording is off now, or the store changed since: build a reader for
		// the store this recording was written to.
		cfg := m.cfg
		cfg.Storage = r.Storage
		var err error
		if st, err = newStore(cfg, m.pool); err != nil {
			return nil, err
		}
	}
	var buf bytes.Buffer
	for i := 0; i < r.Parts; i++ {
		part, err := st.GetPart(ctx, r.location, i)
		if err != nil {
			return nil, fmt.Errorf("part %d: %w", i, err)
		}
		buf.Write(part)
	}
	return buf.Bytes(), nil
}

func storeKind(s Store) string {
	switch s.(type) {
	case *s3Store:
		return "s3"
	case fileStore:
		return "file"
	case dbStore:
		return "database"
	}
	return ""
}

var (
	csi = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	osc = regexp.MustCompile(`\x1b\][^\x07\x1b]*(\x07|\x1b\\)`)
	esc = regexp.MustCompile(`\x1b[@-Z\\-_]`)
)

// Transcript turns an asciicast into plain text: the output events joined,
// terminal control sequences removed, carriage returns and backspaces applied
// per line. For reading and searching; the cast is the record.
func Transcript(cast []byte) string {
	var out strings.Builder
	sc := bufio.NewScanner(bytes.NewReader(cast))
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	first := true
	for sc.Scan() {
		line := sc.Bytes()
		if first {
			first = false
			continue // header
		}
		var ev []any
		if json.Unmarshal(line, &ev) != nil || len(ev) < 3 {
			continue
		}
		code, _ := ev[1].(string)
		data, _ := ev[2].(string)
		switch code {
		case "o":
			out.WriteString(data)
		case "m":
			out.WriteString("\n[" + data + "]\n")
		}
	}
	text := osc.ReplaceAllString(out.String(), "")
	text = csi.ReplaceAllString(text, "")
	text = esc.ReplaceAllString(text, "")
	var b strings.Builder
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		b.WriteString(applyControls(l))
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}

// applyControls replays \r (back to column 0) and \b (one left) on one line.
func applyControls(l string) string {
	var row []rune
	col := 0
	for _, r := range l {
		switch {
		case r == '\r':
			col = 0
		case r == '\b':
			if col > 0 {
				col--
			}
		case r < 0x20 && r != '\t':
			// other control characters carry no text
		default:
			if col < len(row) {
				row[col] = r
			} else {
				row = append(row, r)
			}
			col++
		}
	}
	return string(row)
}
