package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// requirePerm extracts the caller's token payload and verifies it holds perm,
// writing a 403 and returning ok=false otherwise. Mirrors the inline check used
// across the admin handlers.
func requirePerm(w http.ResponseWriter, r *http.Request, perm string) (auth.TokenPayload, bool) {
	payload, ok := auth.FromContext(r.Context())
	if !ok || !payload.HasPermission(perm) {
		response.Error(w, http.StatusForbidden, "Permission denied")
		return auth.TokenPayload{}, false
	}
	return payload, true
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
