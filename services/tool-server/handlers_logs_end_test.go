package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// kubeletLogs answers kubectl logs as the kubelet does: --tail picks the window and --limit-bytes then stops it that many
// bytes after the window's start, so a limit smaller than the window leaves the newest lines out.
func kubeletLogs(t *testing.T, lines []string) *[][]string {
	t.Helper()
	return fakeKubectl(t, func(args []string) (string, error) {
		v := verb(args)
		window := lines
		if i := slices.Index(v, "--tail"); i >= 0 {
			if n, err := strconv.Atoi(v[i+1]); err == nil && n < len(window) {
				window = window[len(window)-n:]
			}
		}
		out := strings.Join(window, "\n") + "\n"
		if i := slices.Index(v, "--limit-bytes"); i >= 0 {
			if n, err := strconv.Atoi(v[i+1]); err == nil && n < len(out) {
				out = out[:n]
			}
		}
		return out, nil
	})
}

func logLines(n int) []string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf("line-%04d padding padding", i)
	}
	return lines
}

func withOutputCap(t *testing.T, limit int) {
	t.Helper()
	saved := outputMaxBytes
	outputMaxBytes = limit
	t.Cleanup(func() { outputMaxBytes = saved })
}

func TestPodLogs_AWindowLargerThanTheOutputKeepsTheNewestLines(t *testing.T) {
	withOutputCap(t, 1000)
	lines := logLines(200)
	kubeletLogs(t, lines)
	out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop", "tail_lines": 150}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, lines[199]) {
		t.Errorf("the newest line is gone: first %q, end %q", firstBytes(out, 60), lastBytes(out, 60))
	}
	if strings.Contains(out, lines[50]) {
		t.Errorf("the oldest line of the window stayed and the newest may not: first %q", firstBytes(out, 60))
	}
	notice, log, found := strings.Cut(out, "\n")
	if !found || !strings.Contains(notice, "older lines") {
		t.Errorf("the cut is not said in the first line: %q", notice)
	}
	if !strings.HasPrefix(log, "line-") {
		t.Errorf("the log starts inside a line: %q", firstBytes(log, 40))
	}
	if len(log) > outputMaxBytes {
		t.Errorf("%d bytes of log, the output holds %d", len(log), outputMaxBytes)
	}
}

func TestPodLogs_AWindowThatFitsIsAnsweredAsItIs(t *testing.T) {
	withOutputCap(t, 100000)
	lines := logLines(20)
	kubeletLogs(t, lines)
	out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.Join(lines, "\n") + "\n"; out != want {
		t.Errorf("got %q, want %q", firstBytes(out, 80), firstBytes(want, 80))
	}
}

func TestPodLogs_ALineOfExactlyTheCapIsNotCalledCut(t *testing.T) {
	line := strings.Repeat("x", 99)
	withOutputCap(t, len(line)+1)
	kubeletLogs(t, []string{line})
	out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if out != line+"\n" {
		t.Errorf("%q", firstBytes(out, 80))
	}
}

func TestPodLogs_ASearchOfALongWindowFindsTheNewestMatch(t *testing.T) {
	withOutputCap(t, 1000)
	lines := logLines(200)
	lines[20] = "line-0020 ERROR the oldest"
	lines[199] = "line-0199 ERROR the newest"
	kubeletLogs(t, lines)
	out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop", "grep": "error"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "ERROR the newest") {
		t.Errorf("the newest match is gone: %q", out)
	}
	if !strings.Contains(out, "older lines") {
		t.Errorf("the search does not say it saw part of the window: %q", out)
	}
}

func TestPodLogs_AFailureIsStillExplained(t *testing.T) {
	fakeKubectl(t, func(args []string) (string, error) {
		return kubectlErr(`Error from server (BadRequest): previous terminated container "app" in pod "web-1" not found`)
	})
	out, err := handleGetPodLogs(context.Background(), args{"pod_name": "web-1", "namespace": "shop", "previous": true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m := decode(t, out); m["status"] != "no_previous" {
		t.Errorf("%s", out)
	}
}

// Only the bytes a log read keeps stay in memory, however much kubectl prints: the real kubectlExec, on a stand-in binary.
func TestKubectlExec_ALogReadHoldsOnlyTheEndOfWhatKubectlPrints(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\ni=0\nwhile [ $i -lt 2000 ]; do echo \"line-$i\"; i=$((i+1)); done\necho to-stderr >&2\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	out, err := realKubectlExec(keepingEnd(context.Background(), 64), []string{"logs", "web-1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 64 {
		t.Errorf("%d bytes kept, want 64: %q", len(out), out)
	}
	if text := string(out); !strings.Contains(text, "line-1999\n") || !strings.Contains(text, "to-stderr") {
		t.Errorf("the end is gone: %q", text)
	}
	whole, err := realKubectlExec(context.Background(), []string{"logs", "web-1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(whole), "line-0\n") {
		t.Errorf("another read lost its start: %q", firstBytes(string(whole), 20))
	}
}

func TestEndBuffer_KeepsTheLastBytesOfEveryShapeOfWrite(t *testing.T) {
	for _, chunk := range []int{1, 3, 7, 10, 11, 64, 1000} {
		b := newEndBuffer(10)
		text := strings.Repeat("0123456789abcdefg", 40)
		for i := 0; i < len(text); i += chunk {
			end := min(i+chunk, len(text))
			if n, err := b.Write([]byte(text[i:end])); err != nil || n != end-i {
				t.Fatalf("chunk %d: wrote %d, %v", chunk, n, err)
			}
		}
		if got, want := string(b.bytes()), text[len(text)-10:]; got != want {
			t.Errorf("chunk %d: %q, want %q", chunk, got, want)
		}
		if len(b.buf) > 2*10+chunk {
			t.Errorf("chunk %d: holds %d bytes", chunk, len(b.buf))
		}
	}
	short := newEndBuffer(10)
	_, _ = short.Write([]byte("abc"))
	if string(short.bytes()) != "abc" {
		t.Errorf("%q", short.bytes())
	}
}

func firstBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func lastBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
