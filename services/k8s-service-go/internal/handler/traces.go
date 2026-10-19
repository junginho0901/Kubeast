package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/traces"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// SetTraceStore turns on trace reads (chart features.traceStore).
func (h *Handler) SetTraceStore(s *traces.Store) { h.traceStore = s }

// traceStoreFeature is the /cluster/features entry: the clusters with trace reads.
func (h *Handler) traceStoreFeature() map[string]interface{} {
	if h.traceStore == nil {
		return map[string]interface{}{"enabled": false, "clusters": []string{}}
	}
	return map[string]interface{}{"enabled": true, "clusters": h.traceStore.Config().ClusterIDs()}
}

func (h *Handler) openTraceDoor(w http.ResponseWriter, r *http.Request, namespace, action string, prepare func() error, after func() json.RawMessage) bool {
	var limit int
	if h.traceStore != nil {
		limit = h.traceStore.Config().PerUserPerMinute
	}
	return h.openReadDoor(w, r, readStore{h.traceStore, "trace store", "trace reads", limit}, namespace, action, prepare, after)
}

// traceWindow reads start/end (RFC 3339) or since and checks them; optional
// leaves an empty window empty (a trace read by ID searches all the store holds).
func (h *Handler) traceWindow(r *http.Request, optional bool) (time.Time, time.Time, error) {
	q := r.URL.Query()
	var start, end time.Time
	for key, dst := range map[string]*time.Time{"start": &start, "end": &end} {
		if v := q.Get(key); v != "" {
			t, err := time.Parse(time.RFC3339Nano, v)
			if err != nil {
				return start, end, fmt.Errorf("%s must be RFC 3339", key)
			}
			*dst = t
		}
	}
	if v := q.Get("since"); v != "" {
		if q.Get("start") != "" {
			return start, end, fmt.Errorf("since and start are exclusive")
		}
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return start, end, fmt.Errorf("since must be a positive duration")
		}
		if end.IsZero() {
			end = time.Now()
		}
		start = end.Add(-d)
	}
	if optional && start.IsZero() && end.IsZero() {
		return start, end, nil
	}
	err := h.traceStore.Config().NormalizeRange(&start, &end, time.Now())
	return start, end, err
}

// traceReadStatus is the status for a failed trace read.
func traceReadStatus(err error) int {
	var se *traces.StoreError
	switch {
	case errors.Is(err, traces.ErrInvalidTraceQL), errors.Is(err, traces.ErrInvalidRequest):
		return http.StatusBadRequest
	case errors.As(err, &se) && se.Status == http.StatusBadRequest:
		return http.StatusBadRequest // the store could not run the query: the caller's to fix
	case errors.Is(err, traces.ErrNotServed), errors.Is(err, traces.ErrNotFound), errors.Is(err, traces.ErrNotConfigured):
		return http.StatusNotFound
	case errors.Is(err, traces.ErrTimeout):
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

// traceAudit is the after payload of a trace read: what was asked and sent and
// how much came back, never span contents.
func traceAudit(kind, query, effective string, start, end time.Time, counts map[string]interface{}) json.RawMessage {
	cut := func(s string, n int) string {
		if r := []rune(s); len(r) > n {
			return string(r[:n])
		}
		return s
	}
	after := map[string]interface{}{"kind": kind}
	if query != "" {
		after["traceql"] = cut(query, 1000)
	}
	if effective != "" {
		after["effective"] = cut(effective, 1200)
	}
	if !start.IsZero() {
		after["range_seconds"] = int64(end.Sub(start).Seconds())
	}
	for k, v := range counts {
		after[k] = v
	}
	b, _ := json.Marshal(after)
	return b
}

// traceRead runs one audited trace read: the door, the read, the audit row, the answer.
func (h *Handler) traceRead(w http.ResponseWriter, r *http.Request, namespace, kind string, prepare func() error, read func(sc traces.Scope, start, end time.Time) (interface{}, string, map[string]interface{}, error)) {
	id, _ := cluster.FromContext(r.Context())
	query := r.URL.Query().Get("q")
	var start, end time.Time
	var effective string
	var counts map[string]interface{}
	after := func() json.RawMessage { return traceAudit(kind, query, effective, start, end, counts) }
	wrapped := func() error {
		var err error
		if start, end, err = h.traceWindow(r, kind == "trace"); err != nil {
			return err
		}
		return prepare()
	}
	if !h.openTraceDoor(w, r, namespace, "k8s.traces.query", wrapped, after) {
		return
	}
	out, eff, c, rerr := read(traces.Scope{Cluster: string(id), Namespace: namespace}, start, end)
	effective, counts = eff, c
	if werr := h.recordAuditWithPayload(r, "k8s.traces.query", "namespace", namespace, namespace, rerr, nil, after()); werr != nil {
		h.refuseUnaudited(w, r, werr)
		return
	}
	if rerr != nil {
		if errors.Is(rerr, traces.ErrNotServed) {
			rerr = fmt.Errorf("this %w (Tempo's HTTP API at the configured URL?)", rerr)
		}
		response.Error(w, traceReadStatus(rerr), rerr.Error())
		return
	}
	response.JSON(w, http.StatusOK, out)
}

func needQuery(r *http.Request) error {
	if strings.TrimSpace(r.URL.Query().Get("q")) == "" {
		return fmt.Errorf("q (TraceQL) is required")
	}
	return nil
}

// TraceSearchNamespace / TraceSearchAll handle GET /api/v1/[namespaces/{namespace}/]traces/search.
func (h *Handler) TraceSearchNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveTraceSearch(w, r, chi.URLParam(r, "namespace"))
}
func (h *Handler) TraceSearchAll(w http.ResponseWriter, r *http.Request) {
	h.serveTraceSearch(w, r, "")
}

func (h *Handler) serveTraceSearch(w http.ResponseWriter, r *http.Request, namespace string) {
	h.traceRead(w, r, namespace, "search", func() error { return needQuery(r) }, func(sc traces.Scope, start, end time.Time) (interface{}, string, map[string]interface{}, error) {
		res, err := h.traceStore.Search(r.Context(), sc, r.URL.Query().Get("q"), start, end, queryParamInt(r, "limit", 0), queryParamInt(r, "spss", 0))
		return res, res.EffectiveQuery, map[string]interface{}{"traces": len(res.Traces)}, err
	})
}

// TraceMetricsNamespace / TraceMetricsAll handle GET …/traces/metrics (TraceQL metrics, ?step= seconds).
func (h *Handler) TraceMetricsNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveTraceMetrics(w, r, chi.URLParam(r, "namespace"))
}
func (h *Handler) TraceMetricsAll(w http.ResponseWriter, r *http.Request) {
	h.serveTraceMetrics(w, r, "")
}

func (h *Handler) serveTraceMetrics(w http.ResponseWriter, r *http.Request, namespace string) {
	h.traceRead(w, r, namespace, "metrics", func() error { return needQuery(r) }, func(sc traces.Scope, start, end time.Time) (interface{}, string, map[string]interface{}, error) {
		step := time.Duration(queryParamInt(r, "step", 0)) * time.Second
		res, err := h.traceStore.Metrics(r.Context(), sc, r.URL.Query().Get("q"), start, end, step)
		return res, res.EffectiveQuery, map[string]interface{}{"series": len(res.Series)}, err
	})
}

// TraceCompareNamespace / TraceCompareAll handle GET …/traces/compare.
func (h *Handler) TraceCompareNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveTraceCompare(w, r, chi.URLParam(r, "namespace"))
}
func (h *Handler) TraceCompareAll(w http.ResponseWriter, r *http.Request) {
	h.serveTraceCompare(w, r, "")
}

func (h *Handler) serveTraceCompare(w http.ResponseWriter, r *http.Request, namespace string) {
	h.traceRead(w, r, namespace, "compare", func() error { return needQuery(r) }, func(sc traces.Scope, start, end time.Time) (interface{}, string, map[string]interface{}, error) {
		res, err := h.traceStore.Compare(r.Context(), sc, r.URL.Query().Get("q"), start, end, queryParamInt(r, "limit", 0), queryParamInt(r, "per_group", 0))
		return res, res.EffectiveQuery, map[string]interface{}{"traces": res.Traces}, err
	})
}

// TraceGetNamespace / TraceGetAll handle GET …/traces/trace/{traceID}: the
// trace's spans in the caller's cluster (and namespace) only.
func (h *Handler) TraceGetNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveTraceGet(w, r, chi.URLParam(r, "namespace"))
}
func (h *Handler) TraceGetAll(w http.ResponseWriter, r *http.Request) { h.serveTraceGet(w, r, "") }

func (h *Handler) serveTraceGet(w http.ResponseWriter, r *http.Request, namespace string) {
	traceID := chi.URLParam(r, "traceID")
	h.traceRead(w, r, namespace, "trace", func() error { return traces.CheckTraceID(traceID) }, func(sc traces.Scope, start, end time.Time) (interface{}, string, map[string]interface{}, error) {
		res, err := h.traceStore.Trace(r.Context(), sc, traceID, start, end)
		return res, "", map[string]interface{}{"trace_id": traceID, "spans": len(res.Spans), "hidden": res.Hidden}, err
	})
}

// TraceTagsNamespace / TraceTagsAll handle GET …/traces/tags: attribute names
// by scope (?scope=), or one attribute's values (?tag=), on the caller's
// spans. Names and values are not span contents, so the read is not audited.
func (h *Handler) TraceTagsNamespace(w http.ResponseWriter, r *http.Request) {
	h.serveTraceTags(w, r, chi.URLParam(r, "namespace"))
}
func (h *Handler) TraceTagsAll(w http.ResponseWriter, r *http.Request) { h.serveTraceTags(w, r, "") }

func (h *Handler) serveTraceTags(w http.ResponseWriter, r *http.Request, namespace string) {
	id, _ := cluster.FromContext(r.Context())
	var start, end time.Time
	prepare := func() (err error) {
		start, end, err = h.traceWindow(r, false)
		return err
	}
	if !h.openTraceDoor(w, r, namespace, "", prepare, nil) {
		return
	}
	q := r.URL.Query()
	res, err := h.traceStore.Tags(r.Context(), traces.Scope{Cluster: string(id), Namespace: namespace}, q.Get("scope"), q.Get("tag"), start, end)
	if err != nil {
		if errors.Is(err, traces.ErrNotServed) {
			err = fmt.Errorf("attribute lists %w", err)
		}
		response.Error(w, traceReadStatus(err), err.Error())
		return
	}
	response.JSON(w, http.StatusOK, res)
}
