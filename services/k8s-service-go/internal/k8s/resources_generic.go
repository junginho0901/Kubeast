package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// GetGenericResources lists any resource type by name.
func (s *Service) GetGenericResources(ctx context.Context, resourceType, namespace, labelSelector string) ([]map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	opts := metav1.ListOptions{}
	if labelSelector != "" {
		opts.LabelSelector = labelSelector
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	listIn := func(ns string) ([]map[string]interface{}, error) {
		list, err := s.ListResources(ctx, gvr, ns, opts)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", resourceType, err)
		}
		return genericResourceRows(list), nil
	}
	if namespaced && ns == "" {
		return s.listAcrossNamespaces(ctx, listIn)
	}
	result, err := listIn(ns)
	if err != nil {
		return nil, err
	}
	if isNamespaceKind(gvr) {
		result = slices.DeleteFunc(result, func(row map[string]interface{}) bool {
			name, _ := row["name"].(string)
			return !inCallerScope(ctx, name)
		})
	}
	return result, nil
}

// genericResourceRows is a list as the generic resources API answers it.
func genericResourceRows(list *unstructured.UnstructuredList) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(list.Items))
	for _, item := range list.Items {
		entry := map[string]interface{}{
			"name":        item.GetName(),
			"namespace":   item.GetNamespace(),
			"kind":        item.GetKind(),
			"api_version": item.GetAPIVersion(),
			"labels":      item.GetLabels(),
			"created_at":  toISO(&metav1.Time{Time: item.GetCreationTimestamp().Time}),
		}

		// Extract common status fields if present
		if status := mapMap(item.Object, "status"); status != nil {
			if phase := mapStr(status, "phase"); phase != "" {
				entry["phase"] = phase
			}
			if conditions := mapSlice(status, "conditions"); len(conditions) > 0 {
				entry["condition_count"] = len(conditions)
			}
		}

		result = append(result, entry)
	}
	return result
}

// Advanced Search lists in pages, as kubectl does (--chunk-size 500), so one list of a large cluster no longer
// holds every object in k8s-service's memory (10 000 pods took it past its 512Mi limit, 10-29), and stops after
// the page's own limit of objects of a type — at most SearchMaxItems, the most the page lets a person ask for.
const (
	SearchPageSize = 500
	SearchMaxItems = 10000
)

// StreamGenericResourcesRaw lists resources page by page as full unstructured objects without managedFields:
// head once with the list's kind and apiVersion after the first page and before any item, then item for each
// object, up to max of them. truncated says more were there; remaining counts them when the API server tells.
// Each object goes with its kubectl STATUS: the list is read as the API server prints it for kubectl get (a Table
// with the whole object, kubectl v1.37 get.go) and the cell of its Status column goes with the object — nil for a
// kind kubectl prints no Status for, or an API that prints no tables, which is read as a plain list. A caller whose
// grant is limited to namespaces asking every namespace of a namespaced kind gets each of its namespaces in turn:
// the cluster refuses the whole list to such a grant (namespace_scope.go); of the Namespace objects it gets its own.
func (s *Service) StreamGenericResourcesRaw(ctx context.Context, resourceType, namespace, labelSelector string, max int,
	head func(kind, apiVersion string) error, item func(obj map[string]interface{}, status *string) error) (truncated bool, remaining int64, err error) {
	m, err := s.resolveResourceMatch(ctx, resourceType)
	if err != nil {
		return false, 0, err
	}
	gvr, namespaced := m.gvr, m.namespaced
	if !namespaced {
		namespace = ""
	}
	if isNamespaceKind(gvr) {
		every := item
		item = func(obj map[string]interface{}, status *string) error {
			name, _ := mapMap(obj, "metadata")["name"].(string)
			if !inCallerScope(ctx, name) {
				return nil
			}
			return every(obj, status)
		}
	}
	tables := true
	listIn := func(ns string) func(metav1.ListOptions) (rawPage, error) {
		return func(opts metav1.ListOptions) (rawPage, error) {
			if tables {
				p, err := s.tablePage(ctx, gvr, m.kind, ns, opts)
				if err == nil {
					return p, nil
				}
				if !errors.Is(err, errNoTable) && !apierrors.IsNotAcceptable(err) && !apierrors.IsUnsupportedMediaType(err) {
					return rawPage{}, fmt.Errorf("list %s: %w", resourceType, err)
				}
				tables = false // this API prints no tables: plain lists from here on
			}
			l, err := s.ListResources(ctx, gvr, ns, opts)
			if err != nil {
				return rawPage{}, fmt.Errorf("list %s: %w", resourceType, err)
			}
			return rawPage{list: l}, nil
		}
	}
	opts := metav1.ListOptions{LabelSelector: labelSelector}
	if scope := scopeFromCtx(ctx); namespaced && namespace == "" && len(scope) > 0 {
		return streamNamespaces(scope, listIn, opts, SearchPageSize, max, head, item)
	}
	return streamPages(listIn(namespace), opts, SearchPageSize, max, head, item)
}

// rawPage is one page of a list: its objects and, when it was read as a table with a Status column, each
// object's cell there.
type rawPage struct {
	list   *unstructured.UnstructuredList
	status []string
}

var errNoTable = errors.New("the API server answered without a table")

// tablePage reads one page of gvr (of kind) in namespace ("" = every namespace) as the API server prints it for
// kubectl get.
func (s *Service) tablePage(ctx context.Context, gvr schema.GroupVersionResource, kind, namespace string, opts metav1.ListOptions) (rawPage, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return rawPage{}, errNotLoaded
	}
	path := []string{"/apis", gvr.Group, gvr.Version}
	if gvr.Group == "" {
		path = []string{"/api", gvr.Version}
	}
	if namespace != "" {
		path = append(path, "namespaces", namespace)
	}
	req := cs.RESTClient().Get().AbsPath(append(path, gvr.Resource)...).Param("includeObject", "Object").SetHeader("Accept", tableAccept)
	if opts.Limit > 0 {
		req = req.Param("limit", strconv.FormatInt(opts.Limit, 10))
	}
	if opts.Continue != "" {
		req = req.Param("continue", opts.Continue)
	}
	if opts.LabelSelector != "" {
		req = req.Param("labelSelector", opts.LabelSelector)
	}
	raw, err := tableBody(ctx, req)
	if err != nil {
		return rawPage{}, err
	}
	var t metav1.Table
	if err := json.Unmarshal(raw, &t); err != nil || t.Kind != "Table" {
		return rawPage{}, errNoTable
	}
	return tableToPage(&t, gvr, kind), nil
}

// tableToPage turns a table into the page's objects and each one's cell in the Status column — the column kubectl
// prints as STATUS (a pod's CrashLoopBackOff, a node's Ready,SchedulingDisabled, a custom resource's printer column
// named Status); no statuses when the kind has none. The page is a <kind>List of gvr's version, as the plain list is.
func tableToPage(t *metav1.Table, gvr schema.GroupVersionResource, kind string) rawPage {
	col := -1
	for i, c := range t.ColumnDefinitions {
		if strings.EqualFold(c.Name, "Status") && c.Format != "name" {
			col = i
			break
		}
	}
	l := &unstructured.UnstructuredList{}
	l.SetKind(kind + "List")
	l.SetAPIVersion(gvr.GroupVersion().String())
	l.SetContinue(t.Continue)
	l.SetRemainingItemCount(t.RemainingItemCount)
	var status []string
	for _, row := range t.Rows {
		obj := unstructured.Unstructured{}
		if err := json.Unmarshal(row.Object.Raw, &obj.Object); err != nil || obj.Object == nil {
			continue
		}
		l.Items = append(l.Items, obj)
		if col >= 0 {
			st := ""
			if col < len(row.Cells) && row.Cells[col] != nil {
				st = fmt.Sprint(row.Cells[col])
			}
			status = append(status, st)
		}
	}
	return rawPage{list: l, status: status}
}

// streamNamespaces runs the list in each namespace of scope in turn, sharing one head and one max: a namespace the
// cluster refuses or does not have is skipped (the grant names it, the cluster is not bound there yet) unless none
// could be read, as listAcrossNamespaces does.
func streamNamespaces(scope []string, listIn func(ns string) func(metav1.ListOptions) (rawPage, error), opts metav1.ListOptions, size, max int,
	head func(kind, apiVersion string) error, item func(map[string]interface{}, *string) error) (bool, int64, error) {
	headSent := false
	once := func(kind, apiVersion string) error {
		if headSent {
			return nil
		}
		headSent = true
		return head(kind, apiVersion)
	}
	sent := 0
	count := func(o map[string]interface{}, st *string) error {
		sent++
		return item(o, st)
	}
	var refused error
	read := false
	for i, ns := range scope {
		truncated, remaining, err := streamPages(listIn(ns), opts, size, max-sent, once, count)
		if err != nil {
			if apierrors.IsForbidden(err) || apierrors.IsNotFound(err) {
				if apierrors.IsForbidden(err) {
					refused = err
				}
				continue
			}
			return false, 0, err
		}
		read = true
		if truncated {
			if i < len(scope)-1 {
				remaining = 0 // more namespaces follow: the rest is not counted
			}
			return true, remaining, nil
		}
	}
	if !read && refused != nil {
		return false, 0, refused
	}
	return false, 0, nil
}

// streamPages runs a list in pages of size (limit and continue) and hands its objects on, up to max, each with its
// status from the page (nil when the page has none).
func streamPages(list func(metav1.ListOptions) (rawPage, error), opts metav1.ListOptions, size, max int,
	head func(kind, apiVersion string) error, item func(map[string]interface{}, *string) error) (bool, int64, error) {
	opts.Limit = int64(size)
	sent := 0
	for first := true; ; first = false {
		p, err := list(opts)
		if err != nil {
			return false, 0, err
		}
		page := p.list
		if first {
			if err := head(page.GetKind(), page.GetAPIVersion()); err != nil {
				return false, 0, err
			}
		}
		for i := range page.Items {
			if sent == max {
				remaining := int64(len(page.Items) - i)
				if rc := page.GetRemainingItemCount(); rc != nil {
					remaining += *rc
				} else if page.GetContinue() != "" {
					remaining = 0 // more pages, count unknown
				}
				return true, remaining, nil
			}
			page.Items[i].SetManagedFields(nil)
			var st *string
			if i < len(p.status) {
				st = &p.status[i]
			}
			if err := item(page.Items[i].Object, st); err != nil {
				return false, 0, err
			}
			sent++
		}
		if page.GetContinue() == "" {
			return false, 0, nil
		}
		if sent == max { // a full page ended at max: the API server's count of the rest, if it gave one
			var remaining int64
			if rc := page.GetRemainingItemCount(); rc != nil {
				remaining = *rc
			}
			return true, remaining, nil
		}
		opts.Continue = page.GetContinue()
	}
}

// GetGenericResourceRaw fetches a single resource returning the full unstructured K8s object.
func (s *Service) GetGenericResourceRaw(ctx context.Context, resourceType, namespace, name string) (map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	obj, err := s.GetResource(ctx, gvr, ns, name)
	if err != nil {
		return nil, fmt.Errorf("get %s %s: %w", resourceType, name, err)
	}

	obj.SetManagedFields(nil)
	return obj.Object, nil
}

// DescribeGenericResource returns details for any resource type.
func (s *Service) DescribeGenericResource(ctx context.Context, resourceType, namespace, name string) (map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	obj, err := s.GetResource(ctx, gvr, ns, name)
	if err != nil {
		return nil, fmt.Errorf("get %s %s: %w", resourceType, name, err)
	}

	obj.SetManagedFields(nil)

	result := map[string]interface{}{
		"name":        obj.GetName(),
		"namespace":   obj.GetNamespace(),
		"kind":        obj.GetKind(),
		"api_version": obj.GetAPIVersion(),
		"labels":      obj.GetLabels(),
		"annotations": obj.GetAnnotations(),
		"created_at":  toISO(&metav1.Time{Time: obj.GetCreationTimestamp().Time}),
	}

	if ownerRefs := obj.GetOwnerReferences(); len(ownerRefs) > 0 {
		owners := make([]map[string]interface{}, 0, len(ownerRefs))
		for _, or := range ownerRefs {
			owners = append(owners, map[string]interface{}{
				"kind": or.Kind,
				"name": or.Name,
				"uid":  string(or.UID),
			})
		}
		result["owner_references"] = owners
	}

	if spec := mapMap(obj.Object, "spec"); spec != nil {
		result["spec"] = spec
	}

	if status := mapMap(obj.Object, "status"); status != nil {
		result["status"] = status
	}
	s.setObjectEvents(ctx, result, obj.GetNamespace(), obj.GetKind(), obj.GetName(), about(obj.GetUID()))

	return result, nil
}

// GetGenericResourceYAML returns any resource as YAML.
func (s *Service) GetGenericResourceYAML(ctx context.Context, resourceType, namespace, name string, forceRefresh bool) (string, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return "", err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	cacheKey := s.clusterCacheKey(ctx, fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, ns, name))
	if !forceRefresh {
		var cached string
		if s.cache.Get(ctx, cacheKey, &cached) {
			return cached, nil
		}
	}

	obj, err := s.GetResource(ctx, gvr, ns, name)
	if err != nil {
		return "", fmt.Errorf("get %s %s: %w", resourceType, name, err)
	}

	obj.SetManagedFields(nil)

	data, err := json.Marshal(obj.Object)
	if err != nil {
		return "", fmt.Errorf("marshal %s: %w", resourceType, err)
	}

	yamlStr := jsonToYAML(data)
	s.cache.Set(ctx, cacheKey, yamlStr, 10*time.Second)
	return yamlStr, nil
}
