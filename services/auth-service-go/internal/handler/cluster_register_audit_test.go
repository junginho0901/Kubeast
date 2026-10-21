package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A kubeconfig the static check refuses (an exec command off the allow list)
// is an admin.cluster.register failure row; the kubeconfig itself is not kept.
func TestRegisterCluster_RefusedKubeconfigIsAFailureRow(t *testing.T) {
	store := &memAuditStore{}
	h := &ClustersHandler{auditStore: store}
	kubeconfig := "apiVersion: v1\nkind: Config\nclusters:\n- name: c\n  cluster:\n    server: https://example:6443\n" +
		"contexts: []\nusers:\n- name: u\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: /bin/sh\n      args: [-c, secret-arg]\n"
	body, _ := json.Marshal(map[string]any{"mode": "external", "display_name": "prod", "kubeconfig": kubeconfig})
	r := httptest.NewRequest(http.MethodPost, "/api/v1/clusters", strings.NewReader(string(body)))
	r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{
		UserID: "a1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {auth.PermClustersCreate}},
	}))
	w := httptest.NewRecorder()
	h.RegisterCluster(w, r)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if len(store.written) != 1 {
		t.Fatalf("want one row, got %d", len(store.written))
	}
	rec := store.written[0]
	if rec.Action != "admin.cluster.register" || rec.Result != audit.ResultFailure || !strings.HasPrefix(rec.Error, "kubeconfig refused: ") {
		t.Fatalf("row: %s %s %q", rec.Action, rec.Result, rec.Error)
	}
	if string(rec.After) != `{"display_name":"prod"}` || strings.Contains(rec.Error+string(rec.After), "secret-arg") {
		t.Fatalf("row keeps more than the name: after=%s error=%q", rec.After, rec.Error)
	}
}
