package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// CustomResourceInstances is every custom resource instance the caller may list and the CRDs it could not list. A
// refused list (403) is named by its Kind as the Resource Graph's forbidden_kinds are, "Kind (namespace, …)" when only
// some of a namespace-scoped grant's namespaces refused it; any other error is in FailedKinds, but a 404 (the CRD went
// between the two lists, or is not served yet), which Gateway → Policies skips too. A Kind two CRDs share carries its
// group, "Widget (qa.example.com)", as the screen's kind picker names it.
type CustomResourceInstances struct {
	Items          []map[string]interface{}    `json:"items"`
	ForbiddenKinds []string                    `json:"forbidden_kinds,omitempty"`
	FailedKinds    []CustomResourceListFailure `json:"failed_kinds,omitempty"`
}

// CustomResourceListFailure is a CRD whose instances could not be listed for a reason other than a refusal.
type CustomResourceListFailure struct {
	Kind  string `json:"kind"`
	Code  int    `json:"code"` // the API server's HTTP status, 0 when it did not answer
	Error string `json:"error"`
}

// GetAllCustomResourceInstances lists all custom resource instances across all CRDs.
func (s *Service) GetAllCustomResourceInstances(ctx context.Context) (*CustomResourceInstances, error) {
	// First get all CRDs
	crdList, err := s.dynamicCtx(ctx).Resource(crdGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list crds for instances: %w", err)
	}

	var mu sync.Mutex
	var wg sync.WaitGroup
	allItems := make([]map[string]interface{}, 0)
	var forbidden []string
	var failed []CustomResourceListFailure

	// Limit concurrency
	sem := make(chan struct{}, 10)
	nsScope := scopeFromCtx(ctx) // a namespace-scoped grant: namespaced CRDs are listed per granted namespace
	kindLabel := crKindLabels(crdList.Items)

	for _, crdItem := range crdList.Items {
		spec, _ := crdItem.Object["spec"].(map[string]interface{})
		if spec == nil {
			continue
		}
		names, _ := spec["names"].(map[string]interface{})
		if names == nil {
			continue
		}

		group, _ := spec["group"].(string)
		scope, _ := spec["scope"].(string)
		crKind, _ := names["kind"].(string)
		crPlural, _ := names["plural"].(string)

		// Find storage version
		version := ""
		if rawVersions, ok := spec["versions"].([]interface{}); ok {
			for _, v := range rawVersions {
				vm, _ := v.(map[string]interface{})
				if storage, _ := vm["storage"].(bool); storage {
					version, _ = vm["name"].(string)
					break
				}
			}
			if version == "" && len(rawVersions) > 0 {
				vm, _ := rawVersions[0].(map[string]interface{})
				version, _ = vm["name"].(string)
			}
		}

		if crPlural == "" || version == "" {
			continue
		}

		gvr := schema.GroupVersionResource{
			Group:    group,
			Version:  version,
			Resource: crPlural,
		}

		wg.Add(1)
		go func(gvr schema.GroupVersionResource, crKind, group, version, scope string, crdName string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			var crItems []unstructured.Unstructured
			var refused []string
			var listErr error
			targets := []string{""}
			if len(nsScope) > 0 && scope == "Namespaced" {
				targets = nsScope
			}
			for _, ns := range targets {
				l, err := s.dynamicCtx(ctx).Resource(gvr).Namespace(ns).List(ctx, metav1.ListOptions{})
				switch {
				case err == nil:
					crItems = append(crItems, l.Items...)
				case apierrors.IsForbidden(err):
					refused = append(refused, ns)
				case apierrors.IsNotFound(err):
					// the CRD went, or is not served yet: nothing to name
				case listErr == nil:
					listErr = err
				}
			}
			label := kindLabel(crKind, group)
			mu.Lock()
			switch {
			case len(refused) == len(targets):
				forbidden = append(forbidden, label)
			case len(refused) > 0:
				forbidden = append(forbidden, label+" ("+strings.Join(refused, ", ")+")")
			}
			if listErr != nil {
				failed = append(failed, CustomResourceListFailure{Kind: label, Code: apiStatusCode(listErr), Error: listErr.Error()})
			}
			mu.Unlock()

			items := make([]map[string]interface{}, 0, len(crItems))
			for _, cr := range crItems {
				createdAt := ""
				if ts := cr.GetCreationTimestamp(); !ts.IsZero() {
					createdAt = ts.UTC().Format("2006-01-02T15:04:05Z")
				}

				items = append(items, map[string]interface{}{
					"name":       cr.GetName(),
					"namespace":  cr.GetNamespace(),
					"kind":       crKind,
					"group":      group,
					"version":    version,
					"scope":      scope,
					"crd_name":   crdName,
					"created_at": createdAt,
					"labels":     cr.GetLabels(),
				})
			}

			mu.Lock()
			allItems = append(allItems, items...)
			mu.Unlock()
		}(gvr, crKind, group, version, scope, crdItem.GetName())
	}

	wg.Wait()

	sortInstances(allItems)
	sort.Strings(forbidden)
	sort.Slice(failed, func(i, j int) bool { return failed[i].Kind < failed[j].Kind })

	return &CustomResourceInstances{Items: allItems, ForbiddenKinds: forbidden, FailedKinds: failed}, nil
}

// sortInstances puts the newest first, and objects of one second in one order whichever list answered first.
func sortInstances(items []map[string]interface{}) {
	field := func(item map[string]interface{}, name string) string {
		value, _ := item[name].(string)
		return value
	}
	sort.Slice(items, func(i, j int) bool {
		if a, b := field(items[i], "created_at"), field(items[j], "created_at"); a != b {
			return a > b
		}
		for _, name := range []string{"crd_name", "namespace", "name"} {
			if a, b := field(items[i], name), field(items[j], name); a != b {
				return a < b
			}
		}
		return false
	})
}

// crKindLabels names a CRD's Kind as the instances screen's kind picker does: the Kind, with its group when another
// CRD has a Kind of that name.
func crKindLabels(crds []unstructured.Unstructured) func(kind, group string) string {
	groups := map[string]map[string]bool{}
	for _, crd := range crds {
		kind, _, _ := unstructured.NestedString(crd.Object, "spec", "names", "kind")
		group, _, _ := unstructured.NestedString(crd.Object, "spec", "group")
		if groups[kind] == nil {
			groups[kind] = map[string]bool{}
		}
		groups[kind][group] = true
	}
	return func(kind, group string) string {
		if len(groups[kind]) > 1 {
			return kind + " (" + group + ")"
		}
		return kind
	}
}

// apiStatusCode is the HTTP status an API error carries, 0 for an error without one (no answer, a timeout here).
func apiStatusCode(err error) int {
	var status apierrors.APIStatus
	if errors.As(err, &status) {
		return int(status.Status().Code)
	}
	return 0
}

// GetCustomResourceInstances lists instances of a specific CR type.
func (s *Service) GetCustomResourceInstances(ctx context.Context, group, version, plural string) ([]map[string]interface{}, error) {
	if scope := scopeFromCtx(ctx); len(scope) > 0 {
		if namespaced, _ := s.ResourceScope(ctx, plural+"."+group); namespaced {
			return fanOutNamespaces(scope, func(ns string) ([]map[string]interface{}, error) {
				t, err := s.tableAt(ctx, "/apis", group, version, "namespaces", ns, plural)
				if err != nil {
					return nil, fmt.Errorf("list custom resources %s/%s/%s: %w", group, version, plural, err)
				}
				return customResourceRows(t, group, version), nil
			})
		}
	}
	t, err := s.customResourceTable(ctx, group, version, plural)
	if err != nil {
		return nil, fmt.Errorf("list custom resources %s/%s/%s: %w", group, version, plural, err)
	}
	return customResourceRows(t, group, version), nil
}

// DescribeCustomResourceInstance is a custom resource as its drawer shows it: the row the instances list shows (the
// API server's Table of the CRD's columns at this version, for this one object — customResourceRows), the object's
// metadata and the events about it, found as kubectl describe finds them (involvedObject name and kind, in every
// namespace for a cluster-scoped kind).
func (s *Service) DescribeCustomResourceInstance(ctx context.Context, group, version, plural, namespace, name string) (map[string]interface{}, error) {
	t, err := s.customResourceObjectTable(ctx, group, version, plural, namespace, name)
	if err != nil {
		return nil, fmt.Errorf("get custom resource %s/%s: %w", namespace, name, err)
	}
	rows := customResourceRows(t, group, version)
	if len(t.Rows) != 1 || len(rows) != 1 {
		return nil, fmt.Errorf("get custom resource %s/%s: the API server answered %d rows", namespace, name, len(t.Rows))
	}
	item := &unstructured.Unstructured{}
	if err := json.Unmarshal(t.Rows[0].Object.Raw, &item.Object); err != nil {
		return nil, fmt.Errorf("get custom resource %s/%s: %w", namespace, name, err)
	}

	evtNs := namespace
	if evtNs == "-" {
		evtNs = ""
	}
	events, eventsErr := s.objectEvents(ctx, evtNs, item.GetKind(), name)

	result := rows[0]
	result["uid"] = string(item.GetUID())
	result["resource_version"] = item.GetResourceVersion()
	result["api_version"] = item.GetAPIVersion()
	setEvents(result, events, eventsErr)

	if fields := topLevelFields(item.Object); len(fields) > 0 {
		result["fields"] = fields
	}

	// Owner references
	if ownerRefs := item.GetOwnerReferences(); len(ownerRefs) > 0 {
		refs := make([]map[string]interface{}, 0, len(ownerRefs))
		for _, ref := range ownerRefs {
			refs = append(refs, map[string]interface{}{
				"kind": ref.Kind,
				"name": ref.Name,
				"uid":  string(ref.UID),
			})
		}
		result["owner_references"] = refs
	}

	// Finalizers
	if finalizers := item.GetFinalizers(); len(finalizers) > 0 {
		result["finalizers"] = finalizers
	}

	// Managed fields summary (server-side apply tracking)
	if managed := item.GetManagedFields(); len(managed) > 0 {
		mfs := make([]map[string]interface{}, 0, len(managed))
		for _, mf := range managed {
			entry := map[string]interface{}{
				"manager":     mf.Manager,
				"operation":   string(mf.Operation),
				"api_version": mf.APIVersion,
				"subresource": mf.Subresource,
			}
			if mf.Time != nil {
				entry["time"] = mf.Time.UTC().Format("2006-01-02T15:04:05Z")
			}
			mfs = append(mfs, entry)
		}
		result["managed_fields"] = mfs
	}

	return result, nil
}

// DeleteCustomResourceInstance deletes a custom resource instance.
func (s *Service) DeleteCustomResourceInstance(ctx context.Context, group, version, plural, namespace, name string) error {
	gvr := schema.GroupVersionResource{
		Group:    group,
		Version:  version,
		Resource: plural,
	}

	if namespace != "" && namespace != "-" {
		return s.dynamicCtx(ctx).Resource(gvr).Namespace(namespace).Delete(ctx, name, metav1.DeleteOptions{})
	}
	return s.dynamicCtx(ctx).Resource(gvr).Delete(ctx, name, metav1.DeleteOptions{})
}

// topLevelFields returns what an object keeps beside apiVersion, kind, metadata, spec and status — a
// PolicyReport's scope, summary and results — for the drawer, whose CRD printer columns may point there.
func topLevelFields(obj map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for k, v := range obj {
		switch k {
		case "apiVersion", "kind", "metadata", "spec", "status":
		default:
			out[k] = v
		}
	}
	return out
}
