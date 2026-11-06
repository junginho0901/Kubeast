package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"sigs.k8s.io/yaml"

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
	if err := h.requirePermissionForCluster(r, "resource.helm.rollback"); err != nil {
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

	// The apply path is audited as a rollback. A dry-run changes nothing; its
	// manifest diff is a reveal like the revision diff (revealDryRunDiff).
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
	if req.DryRun && !h.revealDryRunDiff(w, r, ns, name, "rollback dry-run", &result.Diff, result.MaskedDiff) {
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// TestHelmRelease handles POST /api/v1/helm/releases/{namespace}/{name}/test.
// Runs the release's helm test hooks (usually Pod kind with the
// helm.sh/hook=test annotation) and reports per-hook pass/fail.
func (h *Handler) TestHelmRelease(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.helm.test"); err != nil {
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

	status, body := helmTestAnswer(result, err)
	if status == 0 {
		h.handleHelmError(w, err)
		return
	}
	response.JSON(w, status, body)
}

// helmTestAnswer is what a test run answers. A hook that failed is the test's result, which the screen shows hook by
// hook, not a failure of the service; status 0 is an error with no result, for handleHelmError.
func helmTestAnswer(result *helm.TestResult, err error) (int, any) {
	if err == nil {
		return http.StatusOK, result
	}
	if result == nil || len(result.Hooks) == 0 {
		return 0, nil
	}
	result.Error = response.Public(err)
	return http.StatusOK, result
}

// UpgradeHelmValues handles PUT /api/v1/helm/releases/{namespace}/{name}/values.
// Chart version is preserved — only the user-supplied values map is
// replaced. See docs/helm-plan.md Q5 for why chart upgrade is deferred.
func (h *Handler) UpgradeHelmValues(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.helm.upgrade"); err != nil {
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
		fromRev := 0
		newRev := 0
		if result != nil {
			fromRev = result.FromRevision
			newRev = result.NewRevision
		}
		before := audit.MustJSON(map[string]any{"fromRevision": fromRev})
		after := helmValuesAudit(newRev, req.Values)
		h.recordHelmAudit(r, "helm.release.upgrade", "release", name, ns, helmValuesAuditError(err, req.Values), before, after)
	}

	if err != nil {
		h.handleHelmError(w, err)
		return
	}
	if req.DryRun && !h.revealDryRunDiff(w, r, ns, name, "upgrade dry-run", &result.Diff, result.MaskedDiff) {
		return
	}
	response.JSON(w, http.StatusOK, result)
}

// helmValuesAudit says what an upgrade sent without its text: the row reaches the
// log pipeline and the sinks and cannot be deleted, and values hold passwords. No
// hash either, since it can be guessed against a short value; newRevision names
// the values in the release's own history.
func helmValuesAudit(newRevision int, values string) json.RawMessage {
	keys := []string{}
	var parsed map[string]any
	if yaml.Unmarshal([]byte(values), &parsed) == nil {
		for k := range parsed {
			keys = append(keys, k)
		}
		sort.Strings(keys)
	}
	return audit.MustJSON(map[string]any{
		"newRevision": newRevision,
		"values_keys": keys,
		"values_len":  len(values),
	})
}

// helmValueMinLen is the shortest value taken out of an error: shorter words are no
// credential and would cut into the reason.
const helmValueMinLen = 4

// helmValuesAuditError is an upgrade's error as the audit row keeps it: a chart schema's
// or the API server's refusal quotes the value it refused. The caller's answer keeps the original.
func helmValuesAuditError(err error, values string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, helm.ErrInvalidValues) {
		return helm.ErrInvalidValues
	}
	var parsed any
	if yaml.Unmarshal([]byte(values), &parsed) != nil {
		return err // failed before the values were read, so the error cannot quote them
	}
	texts := helmValueTexts(parsed, nil)
	sort.Slice(texts, func(i, j int) bool { return len(texts[i]) > len(texts[j]) }) // a value inside a longer one goes last
	msg := err.Error()
	for _, text := range texts {
		quoted := strconv.Quote(text)
		quoted = quoted[1 : len(quoted)-1]
		// as is, as Go and the API server quote it, and as the chart schema's validator does
		for _, form := range []string{text, quoted, strings.ReplaceAll(strings.ReplaceAll(quoted, `\"`, `"`), `'`, `\'`)} {
			msg = strings.ReplaceAll(msg, form, "***")
		}
	}
	return errors.New(msg)
}

// helmValueTexts lists the string values of parsed YAML, at any depth.
func helmValueTexts(v any, out []string) []string {
	switch tv := v.(type) {
	case map[string]any:
		for _, inner := range tv {
			out = helmValueTexts(inner, out)
		}
	case []any:
		for _, inner := range tv {
			out = helmValueTexts(inner, out)
		}
	case string:
		if utf8.RuneCountInString(tv) >= helmValueMinLen {
			out = append(out, tv)
		}
	}
	return out
}

// UninstallHelmRelease handles DELETE /api/v1/helm/releases/{namespace}/{name}.
// Query params: keepHistory=true|false (default false), dryRun=true|false.
// The UI is expected to call with dryRun=true first, then re-POST with
// dryRun=false only after the user types the release name into the
// confirm modal — this endpoint itself does not enforce that workflow.
// uninstallConfirmed enforces the "type the release name" confirmation on the
// server: a real uninstall must carry ?confirm=<release name>. Dry runs are
// read-only previews and need no confirmation.
func uninstallConfirmed(confirm, name string, dryRun bool) bool {
	return dryRun || (name != "" && confirm == name)
}

func (h *Handler) UninstallHelmRelease(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.helm.uninstall"); err != nil {
		h.handleError(w, err)
		return
	}
	ns := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	keepHistory := queryParamBool(r, "keepHistory", false)
	dryRun := queryParamBool(r, "dryRun", false)
	if !uninstallConfirmed(r.URL.Query().Get("confirm"), name, dryRun) {
		response.Error(w, http.StatusBadRequest, "confirm must equal the release name")
		return
	}

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
