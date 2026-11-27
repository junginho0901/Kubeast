package response

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
)

// InternalError answers 500 with a generic message and logs the cause with
// the request's method and path. Database and driver errors carry table
// names, constraints and SQLSTATEs that the client has no use for (OWASP
// Error Handling: generic response, details logged server side).
func InternalError(w http.ResponseWriter, r *http.Request, err error) {
	method, path := "", ""
	if r != nil {
		method, path = r.Method, r.URL.Path
	}
	slog.Error("internal error", "method", method, "path", path, "err", err)
	Error(w, http.StatusInternalServerError, "internal server error")
}

// JSON writes a JSON response with the given status code. A value JSON cannot hold (a NaN or an infinity, a channel) is
// logged and answered 500 with a detail: the status goes out after the body is made, never with no body.
func JSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if data == nil {
		w.WriteHeader(status)
		return
	}
	// json.Encoder holds its grown buffer until a slow client takes the answer; this holds the answer's own bytes.
	b, err := json.Marshal(data)
	if err != nil {
		slog.Error("response not encodable", "type", fmt.Sprintf("%T", data), "status", status, "err", err)
		Error(w, http.StatusInternalServerError, "internal server error")
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(b)
	_, _ = w.Write(newline)
}

var newline = []byte{'\n'}

// Error writes a JSON error response matching FastAPI's format.
func Error(w http.ResponseWriter, status int, detail string) {
	JSON(w, status, map[string]string{"detail": detail})
}
