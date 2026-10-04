package main

import (
	"strings"
	"testing"
)

func TestCapOutput_TruncatesWithMarker(t *testing.T) {
	saved := outputMaxBytes
	outputMaxBytes = 16
	defer func() { outputMaxBytes = saved }()

	short := capOutput([]byte("0123456789abcdef"))
	if short != "0123456789abcdef" {
		t.Fatalf("at the limit must pass through: %q", short)
	}
	long := capOutput([]byte(strings.Repeat("x", 100)))
	if !strings.HasPrefix(long, strings.Repeat("x", 16)) || !strings.Contains(long, "output truncated by tool-server: 16 bytes limit") {
		t.Fatalf("over the limit must be cut with the marker: %q", long)
	}
	if strings.Count(long, "x") != 16 {
		t.Fatalf("expected exactly 16 payload bytes, got %d", strings.Count(long, "x"))
	}
}

func TestEnvInt_DefaultsAndParses(t *testing.T) {
	t.Setenv("KUBEAST_TEST_INT", "")
	if got := envInt("KUBEAST_TEST_INT", 7); got != 7 {
		t.Fatalf("unset → default: %d", got)
	}
	t.Setenv("KUBEAST_TEST_INT", "42")
	if got := envInt("KUBEAST_TEST_INT", 7); got != 42 {
		t.Fatalf("set → parsed: %d", got)
	}
	t.Setenv("KUBEAST_TEST_INT", "-1")
	if got := envInt("KUBEAST_TEST_INT", 7); got != 7 {
		t.Fatalf("non-positive → default: %d", got)
	}
}
