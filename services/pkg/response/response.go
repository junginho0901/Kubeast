package response

import (
	"encoding/json"
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

// JSON writes a JSON response with the given status code.
func JSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		json.NewEncoder(w).Encode(data)
	}
}

// Error writes a JSON error response matching FastAPI's format.
func Error(w http.ResponseWriter, status int, detail string) {
	JSON(w, status, map[string]string{"detail": detail})
}
