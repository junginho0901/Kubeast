package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/helm"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// --- Helm write endpoints (v1.1) ---
//
// Every mutation must:
//   - gate on resource.helm.<verb>
//   - emit an audit record under audit.ServiceHelm (via recordHelmAudit)
//   - be safe to invoke with dryRun=true for UI preview before the
//     confirmed apply
//
// The dry-run path is intentionally NOT audited — it performs no
// mutation and auditing every preview keystroke would swamp the log.

// RollbackHelmRelease handles POST /api/v1/helm/releases/{namespace}/{name}/rollback.
func (h *Handler) RollbackHelmRelease(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.rollback"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")

	var req helm.RollbackRequest
	if err := decodeJSON(r, &req); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Revision <= 0 {
		response.Error(w, http.StatusBadRequest, "revision must be positive")
		return
	}

	result, err := h.helmSvc.Rollback(r.Context(), ns, name, req.Revision, req.DryRun)

	// Only the apply path is audited. A dry-run neither mutates the
	// cluster nor is it worth a row per preview.
	if !req.DryRun {
		fromRev := 0
		newRev := 0
		if result != nil {
			fromRev = result.FromRevision
			newRev = result.NewRevision
		}
		before := audit.MustJSON(map[string]any{"revision": fromRev})
		after := audit.MustJSON(map[string]any{
			"toRevision":  req.Revision,
			"newRevision": newRev,
		})
		h.recordHelmAudit(r, "helm.release.rollback", "release", name, ns, err, before, after)
	}

	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// TestHelmRelease handles POST /api/v1/helm/releases/{namespace}/{name}/test.
// Runs the release's helm test hooks (usually Pod kind with the
// helm.sh/hook=test annotation) and reports per-hook pass/fail.
func (h *Handler) TestHelmRelease(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.test"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")

	result, err := h.helmSvc.Test(r.Context(), ns, name)

	// Audit whether the test ran, success vs failure is captured via
	// the Result field (error from action.ReleaseTesting means a hook
	// failed, which for operators is a meaningful outcome).
	var payload json.RawMessage
	if result != nil {
		payload = audit.MustJSON(map[string]any{
			"success":   result.Success,
			"hookCount": len(result.Hooks),
		})
	}
	h.recordHelmAudit(r, "helm.release.test", "release", name, ns, err, nil, payload)

	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// UpgradeHelmValues handles PUT /api/v1/helm/releases/{namespace}/{name}/values.
// Chart version is preserved — only the user-supplied values map is
// replaced. See docs/helm-plan.md Q5 for why chart upgrade is deferred.
func (h *Handler) UpgradeHelmValues(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.upgrade"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")

	var req helm.UpgradeValuesRequest
	if err := decodeJSON(r, &req); err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	result, err := h.helmSvc.UpgradeValues(r.Context(), ns, name, req.Values, req.DryRun)

	if !req.DryRun {
		// MaskSensitive scrubs password-like keys before the values map
		// lands in the audit log. The raw YAML is embedded as a string;
		// masking sees nested maps once the JSON marshaller unpacks it.
		fromRev := 0
		newRev := 0
		if result != nil {
			fromRev = result.FromRevision
			newRev = result.NewRevision
		}
		before := audit.MustJSON(map[string]any{"fromRevision": fromRev})
		after := audit.MaskSensitive(audit.MustJSON(map[string]any{
			"newRevision": newRev,
			"values":      req.Values,
		}))
		h.recordHelmAudit(r, "helm.release.upgrade", "release", name, ns, err, before, after)
	}

	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// UninstallHelmRelease handles DELETE /api/v1/helm/releases/{namespace}/{name}.
// Query params: keepHistory=true|false (default false), dryRun=true|false.
// The UI is expected to call with dryRun=true first, then re-POST with
// dryRun=false only after the user types the release name into the
// confirm modal — this endpoint itself does not enforce that workflow.
func (h *Handler) UninstallHelmRelease(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.helm.uninstall"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	keepHistory := queryParamBool(r, "keepHistory", false)
	dryRun := queryParamBool(r, "dryRun", false)

	result, err := h.helmSvc.Uninstall(r.Context(), ns, name, keepHistory, dryRun)

	if !dryRun {
		before := audit.MustJSON(map[string]any{
			"keepHistory": keepHistory,
		})
		h.recordHelmAudit(r, "helm.release.uninstall", "release", name, ns, err, before, nil)
	}

	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, result)
}
