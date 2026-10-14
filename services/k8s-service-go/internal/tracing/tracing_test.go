package tracing

import (
	"strings"
	"testing"
)

const id32 = "4bf92f3577b34da6a3ce929d0e0e4736"

func TestTraceIDLabelFirstThenText(t *testing.T) {
	t.Setenv("TRACING_ENABLED", "true")
	c := LoadConfig()

	if got := c.TraceID(map[string]string{"trace_id": strings.ToUpper(id32)}, "trace_id=00f067aa0ba902b7"); got != id32 {
		t.Errorf("label first, lower-cased: %q", got)
	}
	for line, want := range map[string]string{
		"GET /api 200 trace_id=" + id32 + " 3ms":               id32,
		`{"level":"info","traceId":"` + id32 + `","msg":"ok"}`: id32,
		"traceID=00f067aa0ba902b7 span=1":                      "00f067aa0ba902b7",
		`{"trace_id": "` + id32 + `"}`:                         id32,
		"trace-id: " + id32:                                    id32,
		"no id here":                                           "",
		"trace_id=" + strings.Repeat("0", 32):                  "", // all zeros is invalid
		"trace_id=" + id32[:20]:                                "", // neither 16 nor 32
		"trace_id=" + id32 + "ff":                              "", // longer than 32
		"subtrace_id=" + id32:                                  "", // not a word on its own
		"trace_id=" + id32[:31] + "g":                          "", // not hex
		`trace_id="javascript:alert(1)//` + id32 + `"`:         "",
	} {
		if got := c.TraceID(nil, line); got != want {
			t.Errorf("%q: got %q, want %q", line, got, want)
		}
	}
	// a label that is not a valid ID falls through to the text
	if got := c.TraceID(map[string]string{"trace_id": "n/a"}, "trace_id="+id32); got != id32 {
		t.Errorf("invalid label value should fall through: %q", got)
	}
}

func TestLoadConfigOverrides(t *testing.T) {
	t.Setenv("TRACING_TRACE_ID_LABELS", "otel_trace , ")
	t.Setenv("TRACING_TRACE_ID_PATTERN", `req=([0-9a-f]{32})`)
	c := LoadConfig()
	if len(c.Labels) != 1 || c.Labels[0] != "otel_trace" {
		t.Errorf("labels: %v", c.Labels)
	}
	if got := c.TraceID(map[string]string{"trace_id": id32}, "x"); got != "" {
		t.Errorf("default label must not apply once overridden: %q", got)
	}
	if got := c.TraceID(nil, "req="+id32); got != id32 {
		t.Errorf("custom pattern: %q", got)
	}
}

func TestValidate(t *testing.T) {
	t.Setenv("TRACING_ENABLED", "true")
	base := LoadConfig()

	ok := base
	ok.TraceURL = "https://jaeger.example.com/trace/{{traceId}}"
	if err := ok.Validate(); err != nil {
		t.Errorf("valid: %v", err)
	}
	for name, mutate := range map[string]func(*Config){
		"no URL":          func(c *Config) {},
		"not http":        func(c *Config) { c.TraceURL = "javascript:alert(1)" },
		"search not http": func(c *Config) { c.TraceURL = "https://x/{{traceId}}"; c.SearchURL = "ftp://x" },
		"bad label":       func(c *Config) { c.TraceURL = "https://x/{{traceId}}"; c.Labels = []string{"trace.id"} },
	} {
		c := base
		mutate(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}

	t.Setenv("TRACING_TRACE_ID_PATTERN", "trace=[0-9a-f]+")
	noGroup := LoadConfig()
	noGroup.TraceURL = "https://x/{{traceId}}"
	if err := noGroup.Validate(); err == nil || !strings.Contains(err.Error(), "group") {
		t.Errorf("pattern without a group: %v", err)
	}
	t.Setenv("TRACING_TRACE_ID_PATTERN", "trace=(")
	broken := LoadConfig()
	broken.TraceURL = "https://x/{{traceId}}"
	if err := broken.Validate(); err == nil {
		t.Errorf("pattern that does not compile: want an error")
	}
}
