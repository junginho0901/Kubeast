package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

func TestWriteAudit_RecordShape(t *testing.T) {
	store := &memAuditStore{}
	r := httptest.NewRequest(http.MethodPut, "/api/v1/auth/admin/roles/7", nil)
	r.Header.Set("X-Real-IP", "203.0.113.9")
	actor := auth.TokenPayload{UserID: "u1", Email: "admin@example.com"}

	writeAudit(store, r, actor, auditEvent{
		action: "admin.roles.update", targetType: "role", targetID: "7",
		before: map[string]any{"name": "ops", "permissions": []string{"menu.*"}},
		after:  map[string]any{"name": "ops", "permissions": []string{"menu.*", "resource.*.read"}, "api_key": "x"},
	})
	writeAudit(store, r, actor, auditEvent{action: "admin.roles.delete", targetType: "role", targetID: "7", err: errors.New("boom")})
	writeAudit(nil, r, actor, auditEvent{action: "ignored"}) // nil store: no panic

	if len(store.written) != 2 {
		t.Fatalf("written = %d", len(store.written))
	}
	ok := store.written[0]
	if ok.Service != audit.ServiceAuth || ok.Action != "admin.roles.update" || ok.TargetType != "role" || ok.TargetID != "7" ||
		ok.ActorUserID != "u1" || ok.ActorEmail != "admin@example.com" || ok.RequestIP != "203.0.113.9" || ok.Result != audit.ResultSuccess {
		t.Fatalf("record = %+v", ok)
	}
	var after map[string]any
	_ = json.Unmarshal(ok.After, &after)
	if after["api_key"] != "***" {
		t.Fatalf("sensitive keys must be masked: %v", after)
	}
	if perms, _ := after["permissions"].([]any); len(perms) != 2 {
		t.Fatalf("after.permissions = %v", after["permissions"])
	}
	failed := store.written[1]
	if failed.Result != audit.ResultFailure || failed.Error != "boom" {
		t.Fatalf("failure record = %+v", failed)
	}
}
