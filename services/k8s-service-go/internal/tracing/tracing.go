// Package tracing links logs to traces (chart features.tracing). Kubeast
// stores no traces: it finds a log line's trace ID — a store label first
// (Loki returns structured metadata such as OTLP's trace_id with the line),
// then the line text — and hands the screen the URL templates of the trace
// backend (Jaeger, Tempo, an APM), which it fills.
package tracing

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

// DefaultPattern finds trace_id=…, traceID=…, "traceId":"…" (and the like) in a
// line; the first group is the ID.
const DefaultPattern = `(?i)\btrace[_-]?id["']?\s*[:=]\s*["']?([0-9a-f]{32}|[0-9a-f]{16})\b`

// Config is the deployment-wide trace link configuration.
type Config struct {
	Enabled bool
	// TraceURL opens one trace ({{traceId}}); SearchURL searches a service's
	// traces from a Pod. Either may be empty.
	TraceURL  string
	SearchURL string
	// Labels are the store label names that may hold the trace ID, in order.
	Labels  []string
	Pattern *regexp.Regexp
	// patternErr is a TRACING_TRACE_ID_PATTERN that did not compile.
	patternErr error
}

// LoadConfig reads the TRACING_* environment.
func LoadConfig() Config {
	c := Config{
		Enabled:   pkgconfig.GetEnvBool("TRACING_ENABLED", false),
		TraceURL:  strings.TrimSpace(os.Getenv("TRACING_TRACE_URL")),
		SearchURL: strings.TrimSpace(os.Getenv("TRACING_SEARCH_URL")),
		Labels:    []string{"trace_id", "traceid", "traceID", "traceId"},
	}
	if v, ok := os.LookupEnv("TRACING_TRACE_ID_LABELS"); ok {
		c.Labels = nil
		for _, l := range strings.Split(v, ",") {
			if l = strings.TrimSpace(l); l != "" {
				c.Labels = append(c.Labels, l)
			}
		}
	}
	pattern := strings.TrimSpace(os.Getenv("TRACING_TRACE_ID_PATTERN"))
	if pattern == "" {
		pattern = DefaultPattern
	}
	c.Pattern, c.patternErr = regexp.Compile(pattern)
	return c
}

var labelName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// Validate rejects a configuration that would link nowhere or to a non-web
// address. Only called when Enabled.
func (c Config) Validate() error {
	if c.TraceURL == "" && c.SearchURL == "" {
		return fmt.Errorf("tracing needs TRACING_TRACE_URL or TRACING_SEARCH_URL")
	}
	for name, u := range map[string]string{"TRACING_TRACE_URL": c.TraceURL, "TRACING_SEARCH_URL": c.SearchURL} {
		if u != "" && !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
			return fmt.Errorf("%s must be an http(s) URL", name)
		}
	}
	for _, l := range c.Labels {
		if !labelName.MatchString(l) {
			return fmt.Errorf("trace ID label %q is not a label name", l)
		}
	}
	if c.patternErr != nil {
		return fmt.Errorf("TRACING_TRACE_ID_PATTERN: %w", c.patternErr)
	}
	if c.Pattern == nil || c.Pattern.NumSubexp() < 1 {
		return fmt.Errorf("TRACING_TRACE_ID_PATTERN needs a group around the trace ID")
	}
	return nil
}

// TraceID returns the trace ID of a log line from its store labels or its
// text, lower-case, or "". Only a W3C trace ID (32 hex digits) or a 64-bit
// one (16, older Jaeger and Zipkin) that is not all zeros counts — the value
// ends up in a URL.
func (c Config) TraceID(labels map[string]string, line string) string {
	for _, l := range c.Labels {
		if id, ok := normalize(labels[l]); ok {
			return id
		}
	}
	if c.Pattern != nil {
		if m := c.Pattern.FindStringSubmatch(line); len(m) > 1 {
			if id, ok := normalize(m[1]); ok {
				return id
			}
		}
	}
	return ""
}

func normalize(v string) (string, bool) {
	v = strings.ToLower(strings.TrimSpace(v))
	if len(v) != 32 && len(v) != 16 {
		return "", false
	}
	zero := true
	for _, r := range v {
		switch {
		case r == '0':
		case (r >= '1' && r <= '9') || (r >= 'a' && r <= 'f'):
			zero = false
		default:
			return "", false
		}
	}
	return v, !zero
}
