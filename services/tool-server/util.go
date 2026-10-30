// 작은 공통 helper. main.go 에서 추출 (Phase 3.6.c).
//
// errBadRequest sentinel 도 같이 옮긴다 — wrapBadRequest 와 짝이고, handleCall
// 의 errors.Is 분기에서만 외부 사용. JSON encode / HTTP 응답 / env 읽기 같은
// 어디에서나 부르는 잡일들.

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
)

var errBadRequest = errors.New("bad request")

func marshalJSON(value interface{}) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// marshalOrdered writes the keys of first, then the others in name order (as json.Marshal does), then those of
// last: the model reads a long reply cut at its tool result length, so what comes first is what it gets.
func marshalOrdered(m map[string]interface{}, first, last []string) (string, error) {
	placed := map[string]bool{}
	for _, k := range append(append([]string{}, first...), last...) {
		placed[k] = true
	}
	var rest []string
	for k := range m {
		if !placed[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	var b strings.Builder
	b.WriteByte('{')
	n := 0
	for _, k := range append(append(append([]string{}, first...), rest...), last...) {
		v, ok := m[k]
		if !ok {
			continue
		}
		key, _ := json.Marshal(k)
		value, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		if n > 0 {
			b.WriteByte(',')
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(value)
		n++
	}
	b.WriteByte('}')
	return b.String(), nil
}

func wrapBadRequest(message string) error {
	return fmt.Errorf("%w: %s", errBadRequest, message)
}

func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
