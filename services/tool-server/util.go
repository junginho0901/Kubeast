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
)

var errBadRequest = errors.New("bad request")

func marshalJSON(value interface{}) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
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
