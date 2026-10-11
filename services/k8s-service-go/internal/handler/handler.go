package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/hygiene"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/logfiles"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/recording"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Handler holds the dependencies for HTTP handlers.
type Handler struct {
	svc        *k8s.Service
	cfg        config.Config
	auditStore audit.Writer
	helmSvc    *helm.Service
	recorder   *recording.Manager // nil or disabled: terminals are not recorded
	// hygieneStore keeps cluster hygiene sign-offs (nil in tests: no history).
	hygieneStore hygiene.Store
	// hygieneScan replaces svc.CollectHygiene in tests.
	hygieneScan func(ctx context.Context, opts k8s.HygieneOptions) (k8s.HygieneReport, error)
	// logFilePatterns are the files the log files view may read (parsed at boot).
	logFilePatterns logfiles.Patterns
	// logFileExec replaces the container exec in tests.
	logFileExec containerCommandFunc
}

// SetRecorder turns on terminal session recording (internal/recording).
func (h *Handler) SetRecorder(m *recording.Manager) { h.recorder = m }

// New creates a new Handler. The helm service is derived from the same
// k8s.Service and cache so Helm SDK calls observe the kubeconfig
// hot-reload path already wired up in main.go.
func New(svc *k8s.Service, cfg config.Config, auditStore audit.Writer) *Handler {
	return &Handler{
		svc:        svc,
		cfg:        cfg,
		auditStore: auditStore,
		helmSvc:    helm.NewService(svc, svc.Cache()),
	}
}

// requirePermission checks that the authenticated user has the given GLOBAL
// permission (the "*" matrix entry) — use it for cluster-agnostic admin.*
// checks. Cluster-scoped resource handlers should use
// requirePermissionForCluster instead.
func (h *Handler) requirePermission(r *http.Request, perm string) error {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		return fmt.Errorf("unauthorized")
	}
	if !payload.HasPermission(perm) {
		return h.denied(r, perm, fmt.Errorf("forbidden: requires %s permission", perm))
	}
	return nil
}

// requirePermissionForCluster checks that the authenticated user holds perm in
// the cluster targeted by the request's ?cluster= parameter (honoring the
// all-cluster "*" grant). When no cluster is set on the context the check falls
// back to the global "*" entry only. Cluster-scoped handlers switch to this in
// step 08; deny-by-default means a non-admin without a per-cluster grant is
// refused (00-COMMON §2-3).
func (h *Handler) requirePermissionForCluster(r *http.Request, perm string) error {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		return fmt.Errorf("unauthorized")
	}
	cid, _ := cluster.FromContext(r.Context())
	if !payload.HasPermissionForCluster(perm, string(cid)) {
		return h.denied(r, perm, fmt.Errorf("forbidden: requires %s permission in cluster %q", perm, cid))
	}
	return nil
}

// canForCluster asks whether the user holds perm in the request's cluster —
// for shaping a response (masking, a button), not for refusing it: nothing is recorded.
func (h *Handler) canForCluster(r *http.Request, perm string) bool {
	payload, ok := auth.FromContext(r.Context())
	if !ok {
		return false
	}
	cid, _ := cluster.FromContext(r.Context())
	return payload.HasPermissionForCluster(perm, string(cid))
}

// denied records a refused write or sensitive action as k8s.access.denied
// (best effort) and returns err. Refused reads are not recorded: the screens
// load lists on their own, so those rows would only pile up.
func (h *Handler) denied(r *http.Request, perm string, err error) error {
	if strings.HasSuffix(perm, ".read") && !strings.HasPrefix(perm, "admin.") {
		return err
	}
	after := audit.MustJSON(map[string]interface{}{"permission": perm, "method": r.Method, "path": r.URL.Path})
	_ = h.recordAuditWithPayload(r, "k8s.access.denied", "permission", perm, "", err, nil, after)
	return err
}

// queryParam returns a query parameter value or a default.
func queryParam(r *http.Request, key, defaultVal string) string {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	return v
}

// queryParamInt returns a query parameter as int or a default.
func queryParamInt(r *http.Request, key string, defaultVal int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return defaultVal
	}
	return i
}

// queryParamBool returns a query parameter as bool or a default.
func queryParamBool(r *http.Request, key string, defaultVal bool) bool {
	v := r.URL.Query().Get(key)
	if v == "" {
		return defaultVal
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return defaultVal
	}
	return b
}

// handleError sends an appropriate error response based on the error message.
func (h *Handler) handleError(w http.ResponseWriter, err error) {
	response.Error(w, statusForError(err), err.Error())
}

// statusForError maps an error to an HTTP status. Kubernetes API errors are
// classified by their status reason (wrapped errors included); the message
// checks below only apply to errors that carry no status, such as helm or
// registry failures.
func statusForError(err error) int {
	switch {
	case errors.Is(err, k8s.ErrNoUser), apierrors.IsUnauthorized(err):
		return http.StatusUnauthorized
	case apierrors.IsForbidden(err):
		return http.StatusForbidden
	case apierrors.IsNotFound(err):
		return http.StatusNotFound
	case apierrors.IsAlreadyExists(err), apierrors.IsConflict(err), errors.Is(err, k8s.ErrAlreadyAtRevision):
		return http.StatusConflict
	case apierrors.IsBadRequest(err), apierrors.IsInvalid(err):
		return http.StatusBadRequest
	case apierrors.IsTimeout(err), apierrors.IsServerTimeout(err), apierrors.IsServiceUnavailable(err):
		return http.StatusServiceUnavailable
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "parse YAML"):
		// The caller's YAML did not parse (duplicate key, bad indent): a request error.
		return http.StatusBadRequest
	case strings.Contains(msg, "unauthorized"):
		return http.StatusUnauthorized
	case strings.Contains(msg, "forbidden"):
		return http.StatusForbidden
	case strings.Contains(msg, "not found"):
		return http.StatusNotFound
	case strings.Contains(msg, "already exists"):
		return http.StatusConflict
	case isClusterUnreachable(msg):
		// A cluster we can't reach/build is temporarily unavailable, not an
		// internal bug — 503 so clients (and fail-fast) treat it as transient.
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

// isClusterUnreachable matches errors from an unreachable / unconfigured cluster
// (build-bundle, registry resolution, dial/timeout) so handleError maps them to
// 503 instead of a blanket 500.
func isClusterUnreachable(msg string) bool {
	for _, s := range []string{
		"build bundle", "registry.Get", "kubeconfig not loaded",
		"connection refused", "no such host", "i/o timeout",
		"context deadline exceeded", "TLS handshake timeout",
	} {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// decodeJSON decodes the request body into the given target.
func decodeJSON(r *http.Request, target interface{}) error {
	if r.Body == nil {
		return fmt.Errorf("request body is empty")
	}
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(target)
}
