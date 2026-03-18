package handler

import (
	"net/http"
	"strings"
	"sync"

	"github.com/junginho0901/kube-assistant/services/pkg/response"
)

// GetGenericResources handles GET /api/v1/resources.
func (h *Handler) GetGenericResources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resourceType := queryParam(r, "resource_type", "")
	namespace := queryParam(r, "namespace", "")
	labelSelector := queryParam(r, "label_selector", "")
	output := queryParam(r, "output", "")
	allNamespaces := queryParamBool(r, "all_namespaces", false)

	if resourceType == "" {
		response.Error(w, http.StatusBadRequest, "resource_type is required")
		return
	}

	// If all_namespaces is set, clear namespace
	if allNamespaces {
		namespace = ""
	}

	// If output=json, return full K8s objects (for Advanced Search)
	if output == "json" {
		data, err := h.svc.GetGenericResourcesRaw(ctx, resourceType, namespace, labelSelector)
		if err != nil {
			h.handleError(w, err)
			return
		}
		response.JSON(w, http.StatusOK, data)
		return
	}

	data, err := h.svc.GetGenericResources(ctx, resourceType, namespace, labelSelector)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// SearchResources handles POST /api/v1/search.
// Supports both single resource_type and multi resource_types (Advanced Search).
func (h *Handler) SearchResources(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var body struct {
		ResourceType   string   `json:"resource_type"`
		ResourceTypes  []string `json:"resource_types"`
		Namespace      string   `json:"namespace"`
		LabelSelector  string   `json:"label_selector"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	// Multi-resource search (Advanced Search)
	if len(body.ResourceTypes) > 0 {
		ns := body.Namespace
		allNamespaces := ns == ""

		type fetchResult struct {
			items []map[string]interface{}
			err   error
			rt    string
		}

		results := make([]fetchResult, len(body.ResourceTypes))
		var wg sync.WaitGroup

		for i, rt := range body.ResourceTypes {
			wg.Add(1)
			go func(idx int, resourceType string) {
				defer wg.Done()
				nsToUse := ns
				if allNamespaces {
					nsToUse = ""
				}
				data, err := h.svc.GetGenericResourcesRaw(ctx, resourceType, nsToUse, body.LabelSelector)
				if err != nil {
					results[idx] = fetchResult{rt: resourceType, err: err}
					return
				}
				items, _ := data["items"].([]map[string]interface{})
				results[idx] = fetchResult{rt: resourceType, items: items}
			}(i, rt)
		}
		wg.Wait()

		allItems := make([]interface{}, 0)
		errors := make([]map[string]interface{}, 0)
		for _, res := range results {
			if res.err != nil {
				errors = append(errors, map[string]interface{}{
					"resource_type": res.rt,
					"error":         res.err.Error(),
				})
			} else {
				for _, item := range res.items {
					allItems = append(allItems, item)
				}
			}
		}

		response.JSON(w, http.StatusOK, map[string]interface{}{
			"items":  allItems,
			"total":  len(allItems),
			"errors": errors,
		})
		return
	}

	// Single resource search
	if body.ResourceType == "" {
		response.Error(w, http.StatusBadRequest, "resource_type is required")
		return
	}

	data, err := h.svc.GetGenericResources(ctx, body.ResourceType, body.Namespace, body.LabelSelector)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// GetGenericResourceYAML handles GET /api/v1/resources/yaml.
func (h *Handler) GetGenericResourceYAML(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resourceType := queryParam(r, "resource_type", "")
	namespace := queryParam(r, "namespace", "")
	name := queryParam(r, "resource_name", "")
	if name == "" {
		name = queryParam(r, "name", "")
	}
	force := queryParamBool(r, "force_refresh", false)

	if resourceType == "" || name == "" {
		response.Error(w, http.StatusBadRequest, "resource_type and resource_name are required")
		return
	}

	data, err := h.svc.GetGenericResourceYAML(ctx, resourceType, namespace, name, force)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, map[string]interface{}{"yaml": data})
}

// ApplyResourceYAML handles POST /api/v1/resources/yaml/apply.
func (h *Handler) ApplyResourceYAML(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}

	var body struct {
		ResourceType string `json:"resource_type"`
		Namespace    string `json:"namespace"`
		Name         string `json:"name"`
		ResourceName string `json:"resource_name"`
		YAML         string `json:"yaml"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if body.Name == "" {
		body.Name = body.ResourceName
	}

	// Node YAML apply requires admin
	if strings.EqualFold(body.ResourceType, "nodes") || strings.EqualFold(body.ResourceType, "node") {
		if err := h.requireAdmin(r); err != nil {
			h.handleError(w, err)
			return
		}
	}

	ctx := r.Context()
	data, err := h.svc.ApplyResourceYAML(ctx, body.ResourceType, body.Namespace, body.Name, body.YAML)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// CreateResourcesFromYAML handles POST /api/v1/resources/yaml/create.
func (h *Handler) CreateResourcesFromYAML(w http.ResponseWriter, r *http.Request) {
	if err := h.requireWrite(r); err != nil {
		h.handleError(w, err)
		return
	}

	var body struct {
		YAML string `json:"yaml"`
	}
	if err := decodeJSON(r, &body); err != nil {
		response.Error(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	ctx := r.Context()
	data, err := h.svc.CreateResourcesFromYAML(ctx, body.YAML)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}

// DescribeGenericResource handles GET /api/v1/resources/describe.
func (h *Handler) DescribeGenericResource(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	resourceType := queryParam(r, "resource_type", "")
	namespace := queryParam(r, "namespace", "")
	name := queryParam(r, "resource_name", "")
	if name == "" {
		name = queryParam(r, "name", "")
	}

	if resourceType == "" || name == "" {
		response.Error(w, http.StatusBadRequest, "resource_type and resource_name are required")
		return
	}

	data, err := h.svc.DescribeGenericResource(ctx, resourceType, namespace, name)
	if err != nil {
		h.handleError(w, err)
		return
	}
	response.JSON(w, http.StatusOK, data)
}
