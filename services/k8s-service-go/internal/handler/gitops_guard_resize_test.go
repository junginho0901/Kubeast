package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A resize request names its workload in the body; the guard looks that
// object up (not the pods) and leaves the body for the handler.
func TestGitopsTargetsFromResizeBody(t *testing.T) {
	body := `{"kind":"Deployment","name":"web","container":"app","cpu_request_m":100}`
	r := httptest.NewRequest(http.MethodPost, "/api/v1/namespaces/apps/optimization/resize", strings.NewReader(body))
	got, err := gitopsTargets(r)
	if err != nil {
		t.Fatal(err)
	}
	want := gitopsTarget{apiVersion: "apps/v1", kind: "Deployment", namespace: "apps", name: "web"}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	rest, _ := io.ReadAll(r.Body)
	if string(rest) != body {
		t.Fatalf("body not restored: %q", rest)
	}

	for _, b := range []string{`{"kind":"Node","name":"n"}`, `{"name":"x"}`, `not json`} {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/namespaces/apps/optimization/resize", strings.NewReader(b))
		if got, _ := gitopsTargets(r); len(got) != 0 {
			t.Errorf("%s: got %+v, want none", b, got)
		}
	}
}
