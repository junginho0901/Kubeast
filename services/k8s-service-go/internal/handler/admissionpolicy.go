package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// GetValidatingAdmissionPolicies handles GET /api/v1/validatingadmissionpolicies.
func (h *Handler) GetValidatingAdmissionPolicies(w http.ResponseWriter, r *http.Request) {
	data, err := h.svc.GetValidatingAdmissionPolicies(r.Context())
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeValidatingAdmissionPolicy handles GET /api/v1/validatingadmissionpolicies/{name}/describe.
func (h *Handler) DescribeValidatingAdmissionPolicy(w http.ResponseWriter, r *http.Request) {
	data, err := h.svc.DescribeValidatingAdmissionPolicy(r.Context(), chi.URLParam(r, "name"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetValidatingAdmissionPolicyYAML handles GET /api/v1/validatingadmissionpolicies/{name}/yaml.
func (h *Handler) GetValidatingAdmissionPolicyYAML(w http.ResponseWriter, r *http.Request) {
	data, err := h.svc.GetGenericResourceYAML(r.Context(), "validatingadmissionpolicies", "", chi.URLParam(r, "name"), queryParamBool(r, "force_refresh", false))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// GetMutatingAdmissionPolicies handles GET /api/v1/mutatingadmissionpolicies.
func (h *Handler) GetMutatingAdmissionPolicies(w http.ResponseWriter, r *http.Request) {
	data, err := h.svc.GetMutatingAdmissionPolicies(r.Context())
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeMutatingAdmissionPolicy handles GET /api/v1/mutatingadmissionpolicies/{name}/describe.
func (h *Handler) DescribeMutatingAdmissionPolicy(w http.ResponseWriter, r *http.Request) {
	data, err := h.svc.DescribeMutatingAdmissionPolicy(r.Context(), chi.URLParam(r, "name"))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetMutatingAdmissionPolicyYAML handles GET /api/v1/mutatingadmissionpolicies/{name}/yaml.
func (h *Handler) GetMutatingAdmissionPolicyYAML(w http.ResponseWriter, r *http.Request) {
	data, err := h.svc.GetGenericResourceYAML(r.Context(), "mutatingadmissionpolicies", "", chi.URLParam(r, "name"), queryParamBool(r, "force_refresh", false))
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}
