package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/recording"
	"github.com/junginho0901/kubeast/services/pkg/audit"
)

type memAudit struct{ rows []audit.Record }

func (m *memAudit) Write(_ context.Context, rec audit.Record) (int64, error) {
	m.rows = append(m.rows, rec)
	return int64(len(m.rows)), nil
}

// The list says how many recordings match in X-Kubeast-Total, so the screen counts its pages; an install that never
// set recording up has none.
func TestRecordingsListSaysHowManyMatch(t *testing.T) {
	h := &Handler{auditStore: &memAudit{}}
	w := httptest.NewRecorder()
	h.ListRecordings(w, hygieneRequest(http.MethodGet, "/api/v1/recordings?limit=12&offset=24", nil, "admin.sessions.read"))
	if w.Code != http.StatusOK || w.Header().Get("X-Kubeast-Total") != "0" || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("no recorder: %d total=%q %s", w.Code, w.Header().Get("X-Kubeast-Total"), w.Body)
	}
}

// A spool that cannot be opened refuses the session when recording is
// required (503 plus a failure audit row), and lets it run unrecorded when not.
func TestStartRecordingWithoutASpool(t *testing.T) {
	dir := t.TempDir()
	blocked := filepath.Join(dir, "spool")
	if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil { // a file where the spool directory should be
		t.Fatal(err)
	}
	for _, required := range []bool{true, false} {
		rec, err := recording.New(recording.Config{Enabled: true, Required: required, MaxBytes: 1 << 20, ChunkSeconds: 30,
			SpoolDir: filepath.Join(blocked, "sub"), Storage: "file", FileDir: filepath.Join(dir, "store")}, nil)
		if err != nil {
			t.Fatal(err)
		}
		store := &memAudit{}
		h := &Handler{auditStore: store}
		h.SetRecorder(rec)
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces/ns/pods/p/exec/ws", nil)
		s, ok := h.startRecording(w, r, "exec", "ns", "p", "c", "k8s.pod.exec", "pod", map[string]interface{}{"container": "c"})
		if s != nil {
			t.Fatal("no session without a spool")
		}
		if required {
			if ok || w.Code != http.StatusServiceUnavailable {
				t.Fatalf("required: ok %v code %d", ok, w.Code)
			}
			if len(store.rows) != 1 || store.rows[0].Result != audit.ResultFailure || store.rows[0].Action != "k8s.pod.exec" {
				t.Fatalf("required: audit rows %+v", store.rows)
			}
		} else if !ok || len(store.rows) != 0 {
			t.Fatalf("best effort: ok %v rows %d", ok, len(store.rows))
		}
	}
}
