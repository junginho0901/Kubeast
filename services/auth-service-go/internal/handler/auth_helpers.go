package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
)

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
