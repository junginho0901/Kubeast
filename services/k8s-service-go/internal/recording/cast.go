package recording

import (
	"encoding/json"
	"os"
	"sync"
	"time"
	"unicode/utf8"
)

// Session is one recording in progress: an asciicast v2 file in the spool
// directory (header line, then [seconds, "o", text] lines). Safe for the
// concurrent stdout/stderr writers of one terminal.
type Session struct {
	ID string

	mu        sync.Mutex
	f         *os.File
	start     time.Time
	written   int64
	max       int64
	truncated bool
	pending   []byte // an incomplete UTF-8 sequence carried to the next write
	closed    bool
	onClose   func(s *Session)
	now       func() time.Time
}

type castHeader struct {
	Version   int               `json:"version"`
	Width     int               `json:"width"`
	Height    int               `json:"height"`
	Timestamp int64             `json:"timestamp"`
	Title     string            `json:"title,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
}

func newSession(id, path string, width, height int, title string, max int64, now func() time.Time) (*Session, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, err
	}
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}
	s := &Session{ID: id, f: f, start: now(), max: max, now: now}
	line, _ := json.Marshal(castHeader{Version: 2, Width: width, Height: height, Timestamp: s.start.Unix(), Title: title, Env: map[string]string{"TERM": "xterm-256color"}})
	if err := s.writeLine(line); err != nil {
		f.Close()
		os.Remove(path)
		return nil, err
	}
	return s, nil
}

func (s *Session) writeLine(b []byte) error {
	b = append(b, '\n')
	n, err := s.f.Write(b)
	s.written += int64(n)
	return err
}

// Output records terminal output. It never fails the terminal: past the size
// cap, or on a disk error, it stops recording and marks the file truncated.
func (s *Session) Output(p []byte) {
	if s == nil || len(p) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.truncated {
		return
	}
	data := append(append([]byte(nil), s.pending...), p...)
	s.pending = nil
	// Hold back a trailing partial UTF-8 sequence so a multi-byte character
	// split across two reads is not recorded as replacement characters.
	if cut := incompleteTail(data); cut > 0 {
		s.pending = append(s.pending, data[len(data)-cut:]...)
		data = data[:len(data)-cut]
	}
	if len(data) == 0 {
		return
	}
	ev, _ := json.Marshal([]any{s.elapsed(), "o", string(data)})
	if s.written+int64(len(ev))+1 > s.max {
		s.truncate("size limit reached; recording stopped")
		return
	}
	if err := s.writeLine(ev); err != nil {
		s.truncate("write error: " + err.Error())
	}
}

func (s *Session) truncate(why string) {
	s.truncated = true
	ev, _ := json.Marshal([]any{s.elapsed(), "m", "kubeast: " + why})
	_ = s.writeLine(ev)
}

func (s *Session) elapsed() float64 {
	return float64(s.now().Sub(s.start).Microseconds()) / 1e6
}

// Truncated reports whether the recording stopped early.
func (s *Session) Truncated() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.truncated
}

// Close ends the recording (idempotent); the manager uploads the rest.
func (s *Session) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	if len(s.pending) > 0 && !s.truncated {
		ev, _ := json.Marshal([]any{s.elapsed(), "o", string(s.pending)})
		_ = s.writeLine(ev)
	}
	_ = s.f.Sync()
	_ = s.f.Close()
	cb := s.onClose
	s.mu.Unlock()
	if cb != nil {
		cb(s)
	}
}

// incompleteTail returns how many trailing bytes form the start of a UTF-8
// sequence that is not complete yet (0 when the data ends on a boundary).
func incompleteTail(b []byte) int {
	for i := 1; i <= 3 && i <= len(b); i++ {
		c := b[len(b)-i]
		if c < 0x80 {
			return 0 // ASCII: boundary
		}
		if c >= 0xC0 { // a leading byte: is its sequence complete?
			if utf8.FullRune(b[len(b)-i:]) {
				return 0
			}
			return i
		}
	}
	return 0
}
