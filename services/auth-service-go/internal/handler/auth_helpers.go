package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// requirePerm extracts the caller's token payload and verifies it holds perm,
// writing a 403 and returning ok=false otherwise — the gate of every admin
// endpoint. A signed-in caller without perm leaves an admin.access.denied
// failure row (after = permission, method, path): the permissions gated here
// are all admin.*, so refused reads are recorded too.
func requirePerm(store audit.Store, w http.ResponseWriter, r *http.Request, perm string) (auth.TokenPayload, bool) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission(perm) {
		if ok {
			recordDenied(store, r, payload, perm)
		}
		response.Error(w, http.StatusForbidden, "Permission denied")
		return auth.TokenPayload{}, false
	}
	return payload, true
}

// recordDenied writes the admin.access.denied row for actor lacking perm.
func recordDenied(store audit.Store, r *http.Request, actor auth.TokenPayload, perm string) {
	writeAudit(store, r, actor, auditEvent{
		action: "admin.access.denied", targetType: "permission", targetID: perm,
		after: map[string]string{"permission": perm, "method": r.Method, "path": r.URL.Path},
		err:   errors.New("permission denied"),
	})
}

func jsonRaw(v interface{}) *json.RawMessage {
	b, _ := json.Marshal(v)
	raw := json.RawMessage(b)
	return &raw
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return i
}
