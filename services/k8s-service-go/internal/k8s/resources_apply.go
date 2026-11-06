package k8s

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

// ApplyResourceYAML applies a strategic merge patch to a resource from YAML.
func (s *Service) ApplyResourceYAML(ctx context.Context, resourceType, namespace, name, yamlStr string) (map[string]interface{}, error) {
	gvr, namespaced, err := s.ResolveResource(ctx, resourceType)
	if err != nil {
		return nil, err
	}

	ns := namespace
	if !namespaced {
		ns = ""
	}

	// Parse YAML to JSON for the patch
	var parsed interface{}
	if err := yaml.Unmarshal([]byte(yamlStr), &parsed); err != nil {
		return nil, fmt.Errorf("parse YAML: %w", err)
	}

	patchData, err := json.Marshal(parsed)
	if err != nil {
		return nil, fmt.Errorf("marshal patch: %w", err)
	}

	var patched *unstructured.Unstructured
	if ns != "" {
		patched, err = s.dynamicCtx(ctx).Resource(gvr).Namespace(ns).Patch(ctx, name, types.StrategicMergePatchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	} else {
		patched, err = s.dynamicCtx(ctx).Resource(gvr).Patch(ctx, name, types.StrategicMergePatchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	}
	if err != nil {
		return nil, fmt.Errorf("patch %s %s: %w", resourceType, name, err)
	}

	s.dropCached(ctx, fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, ns, name))

	return map[string]interface{}{
		"name":        patched.GetName(),
		"namespace":   patched.GetNamespace(),
		"kind":        patched.GetKind(),
		"api_version": patched.GetAPIVersion(),
		"message":     fmt.Sprintf("%s %s updated", resourceType, name),
	}, nil
}

// resolveCreateNamespace 는 Create-from-YAML 시점의 namespace 결정 규칙을 캡슐화.
// 별도 함수로 빼서 테이블 테스트 가능하게 함.
func resolveCreateNamespace(yamlNs, defaultNs string, namespaced bool) string {
	if !namespaced {
		return ""
	}
	if yamlNs != "" {
		return yamlNs
	}
	if defaultNs != "" {
		return defaultNs
	}
	return "default"
}

// YAMLKinds is the kind of every document CreateResourcesFromYAML would create,
// decoded the same way: the documents before a decode error, and that error.
func YAMLKinds(yamlStr string) ([]string, error) {
	decoder := yaml.NewDecoder(bufio.NewReader(bytes.NewBufferString(yamlStr)))
	var kinds []string
	for {
		var rawObj map[string]interface{}
		err := decoder.Decode(&rawObj)
		if err == io.EOF {
			return kinds, nil
		}
		if err != nil {
			return kinds, err
		}
		if rawObj == nil {
			continue
		}
		kind, _ := rawObj["kind"].(string)
		kinds = append(kinds, kind)
	}
}

// CreateResourcesFromYAML creates resources from a YAML string, supporting multi-document YAML.
//
// Namespace 결정 우선순위 (namespaced 리소스에 한해):
//  1. YAML 의 metadata.namespace
//  2. defaultNamespace 인자 (UI 의 namespace 드롭다운에서 선택된 값)
//  3. "default"
//
// cluster-scoped 리소스 (Namespace, ClusterRole 등) 는 위 로직과 무관하게 "" 유지.
func (s *Service) CreateResourcesFromYAML(ctx context.Context, yamlStr, defaultNamespace string) ([]map[string]interface{}, error) {
	var results []map[string]interface{}

	err := s.eachCreateDocument(ctx, yamlStr, defaultNamespace, func(d createDocument) error {
		// The handler's scope check names every document first; this holds for a kind discovery only now resolves.
		if ns, reaches := d.reaches(); reaches && !inCallerScope(ctx, ns) {
			return apierrors.NewForbidden(d.gvr.GroupResource(), d.obj.GetName(), fmt.Errorf("namespace %q is outside your grant on this cluster", ns))
		}
		created, err := s.CreateResource(ctx, d.gvr, d.namespace, d.obj)
		if err != nil {
			return fmt.Errorf("create %s %s: %w", d.obj.GetKind(), d.obj.GetName(), err)
		}

		results = append(results, map[string]interface{}{
			"name":        created.GetName(),
			"namespace":   created.GetNamespace(),
			"kind":        created.GetKind(),
			"api_version": created.GetAPIVersion(),
			"message":     fmt.Sprintf("%s %s created", d.obj.GetKind(), created.GetName()),
		})
		return nil
	})
	return results, err
}

// CreateNamespaces names the namespaces CreateResourcesFromYAML would write in, a Namespace object's name among them,
// for the documents up to the first one it would stop at.
func (s *Service) CreateNamespaces(ctx context.Context, yamlStr, defaultNamespace string) []string {
	var out []string
	_ = s.eachCreateDocument(ctx, yamlStr, defaultNamespace, func(d createDocument) error {
		if ns, reaches := d.reaches(); reaches {
			out = append(out, ns)
		}
		return nil
	})
	return out
}

// CreateObject names one object of a create in its audit row.
type CreateObject struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

// CreateObjects lists the objects CreateResourcesFromYAML would make, up to max of them, and how many there are, in
// the namespaces it would use. A generated name is given as its prefix.
func (s *Service) CreateObjects(ctx context.Context, yamlStr, defaultNamespace string, max int) ([]CreateObject, int) {
	out := []CreateObject{}
	total := 0
	_ = s.eachCreateDocument(ctx, yamlStr, defaultNamespace, func(d createDocument) error {
		total++
		if len(out) < max {
			name := d.obj.GetName()
			if name == "" {
				name = d.obj.GetGenerateName()
			}
			out = append(out, CreateObject{Kind: rowText(d.obj.GetKind()), Name: rowText(name), Namespace: rowText(d.namespace)})
		}
		return nil
	})
	return out, total
}

// rowText keeps a value nothing has validated yet to the longest a Kubernetes name can be, so a row stays a row.
func rowText(s string) string {
	const longestName = 253
	if len(s) > longestName {
		return strings.ToValidUTF8(s[:longestName], "")
	}
	return s
}

// YAMLNamespaces is every metadata.namespace the documents name, a value that is no string as it prints.
func YAMLNamespaces(yamlStr string) []string {
	decoder := yaml.NewDecoder(bufio.NewReader(bytes.NewBufferString(yamlStr)))
	var out []string
	for {
		var rawObj map[string]interface{}
		if err := decoder.Decode(&rawObj); err != nil {
			return out
		}
		meta, _ := rawObj["metadata"].(map[string]interface{})
		if ns := meta["namespace"]; ns != nil && ns != "" {
			out = append(out, fmt.Sprint(ns))
		}
	}
}

// createDocument is one object of a create and where it goes.
type createDocument struct {
	obj       *unstructured.Unstructured
	gvr       schema.GroupVersionResource
	namespace string
}

// reaches is the namespace a document writes in: its own, or a Namespace object's name. false for another cluster-scoped kind.
func (d createDocument) reaches() (string, bool) {
	if d.namespace != "" {
		return d.namespace, true
	}
	if isNamespaceKind(d.gvr) {
		return d.obj.GetName(), true
	}
	return "", false
}

// eachCreateDocument decodes yamlStr a document at a time and hands on each object with its resource and namespace,
// stopping at the first document it cannot read or the first error of fn.
func (s *Service) eachCreateDocument(ctx context.Context, yamlStr, defaultNamespace string, fn func(createDocument) error) error {
	reader := bufio.NewReader(bytes.NewBufferString(yamlStr))
	decoder := yaml.NewDecoder(reader)

	for {
		var rawObj map[string]interface{}
		err := decoder.Decode(&rawObj)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("decode YAML document: %w", err)
		}
		if rawObj == nil {
			continue
		}

		// Convert to JSON for the unstructured object
		jsonData, err := json.Marshal(rawObj)
		if err != nil {
			return fmt.Errorf("marshal to JSON: %w", err)
		}

		obj := &unstructured.Unstructured{}
		if err := json.Unmarshal(jsonData, &obj.Object); err != nil {
			return fmt.Errorf("unmarshal to unstructured: %w", err)
		}

		// Resolve the GVR from the object's apiVersion and kind
		apiVersion := obj.GetAPIVersion()
		kind := obj.GetKind()
		if apiVersion == "" || kind == "" {
			return fmt.Errorf("YAML document missing apiVersion or kind")
		}

		gvr, namespaced, err := s.ResolveKind(ctx, apiVersion, kind)
		if err != nil {
			return err
		}

		namespace := resolveCreateNamespace(obj.GetNamespace(), defaultNamespace, namespaced)
		// 응답의 namespace 필드 + audit 등 후속 동작이 정확한 ns 를 보도록
		// 객체에도 반영. cluster-scoped 면 빈 문자열로 셋되어 무해.
		obj.SetNamespace(namespace)

		if err := fn(createDocument{obj: obj, gvr: gvr, namespace: namespace}); err != nil {
			return err
		}
	}
}
