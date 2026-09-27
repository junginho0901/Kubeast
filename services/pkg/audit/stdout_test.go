package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
)

type fakeStore struct {
	id   int64
	err  error
	last Record
}

func (f *fakeStore) Write(_ context.Context, rec Record) (int64, error) {
	f.last = rec
	return f.id, f.err
}
func (f *fakeStore) List(context.Context, Filter) ([]Entry, int, error) { return nil, 0, nil }
func (f *fakeStore) Get(context.Context, int64) (*Entry, error)         { return nil, nil }

func captureLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, nil)), &buf
}

func oneLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	lines := bytes.Split(bytes.TrimSpace(buf.Bytes()), []byte("\n"))
	if len(lines) != 1 {
		t.Fatalf("want exactly 1 log line, got %d: %s", len(lines), buf.String())
	}
	var got map[string]any
	if err := json.Unmarshal(lines[0], &got); err != nil {
		t.Fatalf("line is not JSON: %v: %s", err, lines[0])
	}
	return got
}

func TestStdoutTee_WritesOneJSONLinePerRecord(t *testing.T) {
	log, buf := captureLogger()
	inner := &fakeStore{id: 42}
	tee := &StdoutTee{Store: inner, log: log}

	id, err := tee.Write(context.Background(), Record{
		Service: ServiceK8s, Action: "k8s.pod.delete",
		ActorUserID: "u1", ActorEmail: "a@example.com",
		TargetType: "pod", TargetID: "web-1",
		Cluster: "alpha", Namespace: "app",
		RequestIP: "10.0.0.1", RequestID: "req-1", Path: "/api/v1/pods/web-1",
		After: json.RawMessage(`{"password":"***","replicas":2}`),
	})
	if err != nil || id != 42 {
		t.Fatalf("Write = (%d, %v), want (42, nil)", id, err)
	}
	got := oneLine(t, buf)
	if got["msg"] != "audit" || got["event"] != "audit" {
		t.Fatalf("msg/event = %v/%v, want audit/audit", got["msg"], got["event"])
	}
	a, _ := got["audit"].(map[string]any)
	for k, want := range map[string]any{
		"id": float64(42), "service": ServiceK8s, "action": "k8s.pod.delete", "result": ResultSuccess,
		"actor_user_id": "u1", "actor_email": "a@example.com", "target_type": "pod", "target_id": "web-1",
		"cluster": "alpha", "namespace": "app", "request_ip": "10.0.0.1", "request_id": "req-1", "path": "/api/v1/pods/web-1",
	} {
		if a[k] != want {
			t.Errorf("audit.%s = %v, want %v", k, a[k], want)
		}
	}
	after, _ := a["after"].(map[string]any)
	if after["password"] != "***" || after["replicas"] != float64(2) {
		t.Errorf("audit.after = %v, want the masked JSON object", a["after"])
	}
	if _, has := a["store_error"]; has {
		t.Errorf("store_error present on a successful write")
	}
	if _, has := a["error"]; has {
		t.Errorf("error present on a successful write")
	}
}

func TestStdoutTee_StillLogsWhenStoreFails(t *testing.T) {
	log, buf := captureLogger()
	inner := &fakeStore{err: errors.New("pg down")}
	tee := &StdoutTee{Store: inner, log: log}

	id, err := tee.Write(context.Background(), Record{Service: ServiceAuth, Action: "user.login", Result: ResultFailure, Error: "bad password"})
	if err == nil || id != 0 {
		t.Fatalf("Write = (%d, %v), want (0, error)", id, err)
	}
	a, _ := oneLine(t, buf)["audit"].(map[string]any)
	if a["store_error"] != "pg down" || a["error"] != "bad password" || a["result"] != ResultFailure {
		t.Fatalf("audit = %v, want store_error/error/result carried", a)
	}
}

func TestStdoutTee_SkipsInvalidJSONPayloads(t *testing.T) {
	log, buf := captureLogger()
	tee := &StdoutTee{Store: &fakeStore{id: 1}, log: log}
	_, _ = tee.Write(context.Background(), Record{Action: "x", Before: json.RawMessage(`not json`), After: json.RawMessage(``)})
	a, _ := oneLine(t, buf)["audit"].(map[string]any)
	if _, has := a["before"]; has {
		t.Errorf("before with invalid JSON must be dropped")
	}
	if _, has := a["after"]; has {
		t.Errorf("empty after must be dropped")
	}
}

func TestWithStdout(t *testing.T) {
	inner := &fakeStore{}
	if got := WithStdout(inner, false); got != Store(inner) {
		t.Fatalf("disabled: want the store itself back")
	}
	if _, ok := WithStdout(inner, true).(*StdoutTee); !ok {
		t.Fatalf("enabled: want a *StdoutTee")
	}
}

func TestStdoutEnabled(t *testing.T) {
	for env, want := range map[string]bool{"": true, "true": true, "1": true, "false": false, "0": false, "off": false, " FALSE ": false} {
		t.Setenv("AUDIT_STDOUT", env)
		if got := StdoutEnabled(); got != want {
			t.Errorf("AUDIT_STDOUT=%q: got %v, want %v", env, got, want)
		}
	}
}

func TestSlogStore_SameLineShape(t *testing.T) {
	log, buf := captureLogger()
	prev := slog.Default()
	slog.SetDefault(log)
	t.Cleanup(func() { slog.SetDefault(prev) })

	s := NewSlogStore(ServiceAI)
	id, err := s.Write(context.Background(), Record{Action: "ai.tool.call", ActorEmail: "a@example.com"})
	if err != nil || id != 1 {
		t.Fatalf("Write = (%d, %v)", id, err)
	}
	got := oneLine(t, buf)
	a, _ := got["audit"].(map[string]any)
	if got["event"] != "audit" || a["action"] != "ai.tool.call" || a["service"] != ServiceAI || a["id"] != float64(1) {
		t.Fatalf("slog store line = %v", got)
	}
}
