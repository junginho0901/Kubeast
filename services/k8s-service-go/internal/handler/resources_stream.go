package handler

import (
	"encoding/json"
	"net/http"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
)

type rawStream func(head func(kind, apiVersion string) error, item func(map[string]interface{}) error) (truncated bool, remaining int64, err error)

// streamRawList answers Advanced Search's list of a type, page by page (k8s.StreamGenericResourcesRaw), up to
// limit objects (1 to k8s.SearchMaxItems, default the most).
func (h *Handler) streamRawList(w http.ResponseWriter, r *http.Request, resourceType, namespace, labelSelector string) {
	limit := queryParamInt(r, "limit", k8s.SearchMaxItems)
	if limit < 1 || limit > k8s.SearchMaxItems {
		limit = k8s.SearchMaxItems
	}
	writeRawList(w, limit, func(head func(string, string) error, item func(map[string]interface{}) error) (bool, int64, error) {
		return h.svc.StreamGenericResourcesRaw(r.Context(), resourceType, namespace, labelSelector, limit, head, item)
	}, h.handleError)
}

// writeRawList writes {"kind","apiVersion","items":[…],"truncated","limit"[,"remaining"][,"error"]} as the
// objects come: the status comes from the first page; an error on a later page ends the list with "error" and
// truncated. Secret values are masked object by object.
func writeRawList(w http.ResponseWriter, limit int, stream rawStream, fail func(http.ResponseWriter, error)) {
	started := false
	sent := 0
	flusher, _ := w.(http.Flusher)
	head := func(kind, apiVersion string) error {
		k, _ := json.Marshal(kind)
		v, _ := json.Marshal(apiVersion)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		started = true
		_, err := w.Write([]byte(`{"kind":` + string(k) + `,"apiVersion":` + string(v) + `,"items":[`))
		return err
	}
	item := func(obj map[string]interface{}) error {
		maskSecretValues(obj)
		b, err := json.Marshal(obj)
		if err != nil {
			return err
		}
		if sent > 0 {
			b = append([]byte{','}, b...)
		}
		if _, err := w.Write(b); err != nil {
			return err
		}
		if sent++; sent%k8s.SearchPageSize == 0 && flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	truncated, remaining, err := stream(head, item)
	if err != nil && !started {
		fail(w, err)
		return
	}
	tail := map[string]interface{}{"truncated": truncated, "limit": limit}
	if remaining > 0 {
		tail["remaining"] = remaining
	}
	if err != nil {
		tail["truncated"], tail["error"] = true, err.Error()
	}
	b, _ := json.Marshal(tail)
	_, _ = w.Write(append([]byte("],"), b[1:]...))
}
