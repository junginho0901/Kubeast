package response

import (
	"bytes"
	"encoding/json"
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

// A value that cannot be encoded leaves the body empty, as the encoder did, and nil writes no body.
func TestJSONOfNoValueOrABadOneWritesNoBody(t *testing.T) {
	for _, v := range []any{nil, math.NaN(), map[string]any{"ch": make(chan int)}} {
		rec := httptest.NewRecorder()
		JSON(rec, http.StatusOK, v)
		if rec.Body.Len() != 0 {
			t.Errorf("%T: body %q, want none", v, rec.Body.String())
		}
	}
}
