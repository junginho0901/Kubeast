package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// --- PVCs ---

// GetAllPVCs handles GET /api/v1/pvcs.
func (h *Handler) GetAllPVCs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetAllPVCs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPVCs handles GET /api/v1/namespaces/{namespace}/pvcs.
func (h *Handler) GetPVCs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	data, err := h.svc.GetPVCs(ctx, namespace)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribePVC handles GET /api/v1/namespaces/{namespace}/pvcs/{name}/describe.
func (h *Handler) DescribePVC(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribePVC(ctx, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPVCYAML handles GET /api/v1/namespaces/{namespace}/pvcs/{name}/yaml.
func (h *Handler) GetPVCYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "persistentvolumeclaims", namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeletePVC handles DELETE /api/v1/namespaces/{namespace}/pvcs/{name}.
func (h *Handler) DeletePVC(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.pvc.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	namespace := chi.URLParam(r, "namespace")
	name := chi.URLParam(r, "name")
	err := h.svc.DeletePVC(ctx, namespace, name)
	h.recordAudit(r, "k8s.pvc.delete", "pvc", name, namespace, err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- PVs ---

// GetPVs handles GET /api/v1/pvs.
func (h *Handler) GetPVs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetPVs(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPV handles GET /api/v1/pvs/{name}.
func (h *Handler) GetPV(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.GetPV(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribePV handles GET /api/v1/pvs/{name}/describe.
func (h *Handler) DescribePV(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribePV(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetPVYAML handles GET /api/v1/pvs/{name}/yaml.
func (h *Handler) GetPVYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	force := queryParamBool(r, "force_refresh", false)
	data, err := h.svc.GetGenericResourceYAML(ctx, "persistentvolumes", "", name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// DeletePV handles DELETE /api/v1/pvs/{name}.
func (h *Handler) DeletePV(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.pv.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeletePV(ctx, name)
	h.recordAudit(r, "k8s.pv.delete", "pv", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- StorageClasses ---

// GetStorageClasses handles GET /api/v1/storageclasses.
func (h *Handler) GetStorageClasses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetStorageClasses(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetStorageClass handles GET /api/v1/storageclasses/{name}.
func (h *Handler) GetStorageClass(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeStorageClass(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeStorageClass handles GET /api/v1/storageclasses/{name}/describe.
func (h *Handler) DescribeStorageClass(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeStorageClass(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteStorageClass handles DELETE /api/v1/storageclasses/{name}.
func (h *Handler) DeleteStorageClass(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.storageclass.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteStorageClass(ctx, name)
	h.recordAudit(r, "k8s.storageclass.delete", "storageclass", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}

// --- VolumeAttachments ---

// GetVolumeAttachments handles GET /api/v1/volumeattachments.
func (h *Handler) GetVolumeAttachments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	data, err := h.svc.GetVolumeAttachments(ctx)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeVolumeAttachment handles GET /api/v1/volumeattachments/{name}/describe.
func (h *Handler) DescribeVolumeAttachment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	data, err := h.svc.DescribeVolumeAttachment(ctx, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DeleteVolumeAttachment handles DELETE /api/v1/volumeattachments/{name}.
func (h *Handler) DeleteVolumeAttachment(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.volumeattachment.delete"); err != nil {
		h.handleError(w, err)
		return
	}
	ctx := r.Context()
	name := chi.URLParam(r, "name")
	err := h.svc.DeleteVolumeAttachment(ctx, name)
	h.recordAudit(r, "k8s.volumeattachment.delete", "volumeattachment", name, "", err)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"deleted": true})
}
