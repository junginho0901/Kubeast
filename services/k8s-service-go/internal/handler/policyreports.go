package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Policy reports (wgpolicyk8s.io, features.policyReports): reads only, no
// audit action. The data routes sit behind ListIfServed, so a cluster without
// the CRD answers an empty list with the not-installed header; status answers
// whether the feature is on and the CRD is served.

func (h *Handler) policyReportsGate(w http.ResponseWriter, r *http.Request) bool {
	if !k8s.PolicyReportsFeatureEnabled() {
		response.Error(w, http.StatusNotFound, "policy reports are off (features.policyReports.enabled)")
		return false
	}
	if err := h.requirePermissionForCluster(r, "resource.policyreport.read"); err != nil {
		h.handleError(w, err)
		return false
	}
	return true
}

// GetPolicyReportStatus handles GET /api/v1/policyreports/status.
func (h *Handler) GetPolicyReportStatus(w http.ResponseWriter, r *http.Request) {
	if !h.policyReportsGate(w, r) {
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{
		"enabled":   true,
		"installed": h.svc.PolicyReportsInstalled(r.Context()),
		"group":     "wgpolicyk8s.io/v1alpha2",
	})
}

// GetPolicyReportSummary handles GET /api/v1/policyreports/summary?namespace=&force_refresh=.
func (h *Handler) GetPolicyReportSummary(w http.ResponseWriter, r *http.Request) {
	if !h.policyReportsGate(w, r) {
		return
	}
	res, err := h.svc.PolicyReportSummary(r.Context(), queryParam(r, "namespace", ""), queryParamBool(r, "force_refresh", false))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// GetPolicyReportResults handles GET /api/v1/policyreports/results?namespace=&policy=&source=&result=&severity=&kind=&search=&offset=&limit=&sort=&dir=.
func (h *Handler) GetPolicyReportResults(w http.ResponseWriter, r *http.Request) {
	if !h.policyReportsGate(w, r) {
		return
	}
	f := k8s.PolicyReportFilter{
		Namespace:  queryParam(r, "namespace", ""),
		Policy:     queryParam(r, "policy", ""),
		Source:     queryParam(r, "source", ""),
		Kind:       queryParam(r, "kind", ""),
		Search:     queryParam(r, "search", ""),
		Results:    splitList(queryParam(r, "result", "")),
		Severities: splitList(queryParam(r, "severity", "")),
		Offset:     queryParamInt(r, "offset", 0),
		Limit:      queryParamInt(r, "limit", 0),
		Sort:       queryParam(r, "sort", ""),
		Desc:       queryParam(r, "dir", "") == "desc",
		Force:      queryParamBool(r, "force_refresh", false),
	}
	if !policyReportSorts[f.Sort] {
		response.Error(w, http.StatusBadRequest, "sort must be result, policy, namespace or name")
		return
	}
	res, err := h.svc.PolicyReportResults(r.Context(), f)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}

// GetResourcePolicyReports handles GET /api/v1/namespaces/{namespace}/policyreports/resource?kind=&name=.
func (h *Handler) GetResourcePolicyReports(w http.ResponseWriter, r *http.Request) {
	if !h.policyReportsGate(w, r) {
		return
	}
	kind, name := queryParam(r, "kind", ""), queryParam(r, "name", "")
	if kind == "" || name == "" {
		response.Error(w, http.StatusBadRequest, "kind and name are required")
		return
	}
	res, err := h.svc.PolicyReportsForResource(r.Context(), chi.URLParam(r, "namespace"), kind, name, queryParamBool(r, "force_refresh", false))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, res)
}

var policyReportSorts = map[string]bool{"": true, "result": true, "policy": true, "namespace": true, "name": true}

func splitList(v string) []string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := parts[:0]
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
