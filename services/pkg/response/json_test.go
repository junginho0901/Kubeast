package response

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type sampleRow struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels,omitempty"`
	Count  int               `json:"count"`
	Ratio  float64           `json:"ratio"`
	Next   *sampleRow        `json:"next,omitempty"`
}

// JSON writes the bytes json.Encoder writes for the same value: the status, the header and the body, newline included.
func TestJSONWritesWhatTheEncoderWrites(t *testing.T) {
	long := strings.Repeat("파드 <b>&amp;</b>   \x01 ", 4000)
	values := []any{
		map[string]string{"detail": "a <script> & \"quote\""},
		[]map[string]interface{}{{"name": "p1", "ready": "1/1", "labels": map[string]string{"app": "web", "z": "1", "a": "2"}}, {"name": "p2", "count": 3, "ratio": 0.1}},
		[]map[string]interface{}{},
		map[string]interface{}{"items": nil, "long": long, "n": int64(math.MaxInt64), "f": 1e21},
		&sampleRow{Name: "x", Labels: map[string]string{"k": "<v>"}, Count: 2, Ratio: 2.5, Next: &sampleRow{Name: "y"}},
		"text",
		json.RawMessage(`{"raw":true}`),
	}
	for i, v := range values {
		var want bytes.Buffer
		if err := json.NewEncoder(&want).Encode(v); err != nil {
			t.Fatal(err)
		}
		rec := httptest.NewRecorder()
		JSON(rec, http.StatusAccepted, v)
		if rec.Code != http.StatusAccepted || rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("value %d: status %d, content type %q", i, rec.Code, rec.Header().Get("Content-Type"))
		}
		if !bytes.Equal(rec.Body.Bytes(), want.Bytes()) {
			t.Errorf("value %d: body differs from the encoder's (%d bytes, want %d)", i, rec.Body.Len(), want.Len())
		}
	}
}

// nil writes the status and no body.
func TestJSONOfNoValueWritesTheStatusAndNoBody(t *testing.T) {
	rec := httptest.NewRecorder()
	JSON(rec, http.StatusNoContent, nil)
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Errorf("status %d, body %q", rec.Code, rec.Body.String())
	}
}

// calls is a ResponseWriter that keeps the order of what was written to it.
type calls struct {
	header http.Header
	log    []string
	body   bytes.Buffer
}

func (c *calls) Header() http.Header { return c.header }
func (c *calls) WriteHeader(status int) {
	c.log = append(c.log, "status "+http.StatusText(status))
}
func (c *calls) Write(b []byte) (int, error) {
	if len(c.log) == 0 || !strings.HasPrefix(c.log[len(c.log)-1], "body") {
		c.log = append(c.log, "body")
	}
	return c.body.Write(b)
}

// A value JSON cannot hold (a Prometheus NaN or infinity, a channel) was a 200 with no body, which a caller reads as
// "unexpected end of JSON input". It is a 500 with the detail InternalError gives, nothing written before it, and one
// log line that says what could not be written.
func TestJSONOfAValueThatCannotBeEncodedIsA500WithADetailNotAnEmptyStatus(t *testing.T) {
	var logged bytes.Buffer
	defer slog.SetDefault(slog.Default())
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))

	for _, v := range []any{
		math.NaN(),
		math.Inf(1),
		map[string]any{"available": true, "results": []map[string]any{{"value": 0.25}, {"value": math.Inf(-1)}}},
		map[string]any{"ch": make(chan int)},
	} {
		logged.Reset()
		w := &calls{header: http.Header{}}
		JSON(w, http.StatusOK, v)
		if strings.Join(w.log, ", ") != "status Internal Server Error, body" {
			t.Errorf("%T: writes %q, want the 500 and then its body", v, w.log)
		}
		if w.body.String() != "{\"detail\":\"internal server error\"}\n" || w.header.Get("Content-Type") != "application/json" {
			t.Errorf("%T: body %q, content type %q", v, w.body.String(), w.header.Get("Content-Type"))
		}
		lines := strings.Split(strings.TrimSpace(logged.String()), "\n")
		if len(lines) != 1 || !strings.Contains(lines[0], "level=ERROR") || !strings.Contains(lines[0], `msg="response not encodable"`) ||
			!strings.Contains(lines[0], "status=200") || !strings.Contains(lines[0], "json: unsupported") {
			t.Errorf("%T: log %q, want one line", v, logged.String())
		}
	}
}
