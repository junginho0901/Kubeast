package k8s

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"gopkg.in/yaml.v3"
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
		patched, err = s.Dynamic().Resource(gvr).Namespace(ns).Patch(ctx, name, types.StrategicMergePatchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	} else {
		patched, err = s.Dynamic().Resource(gvr).Patch(ctx, name, types.StrategicMergePatchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	}
	if err != nil {
		return nil, fmt.Errorf("patch %s %s: %w", resourceType, name, err)
	}

	// Invalidate cache
	cacheKey := fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, ns, name)
	s.cache.Delete(ctx, cacheKey)

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

	reader := bufio.NewReader(bytes.NewBufferString(yamlStr))
	decoder := yaml.NewDecoder(reader)

	for {
		var rawObj map[string]interface{}
		err := decoder.Decode(&rawObj)
		if err == io.EOF {
			break
		}
		if err != nil {
			return results, fmt.Errorf("decode YAML document: %w", err)
		}
		if rawObj == nil {
			continue
		}

		// Convert to JSON for the unstructured object
		jsonData, err := json.Marshal(rawObj)
		if err != nil {
			return results, fmt.Errorf("marshal to JSON: %w", err)
		}

		obj := &unstructured.Unstructured{}
		if err := json.Unmarshal(jsonData, &obj.Object); err != nil {
			return results, fmt.Errorf("unmarshal to unstructured: %w", err)
		}

		// Resolve the GVR from the object's apiVersion and kind
		apiVersion := obj.GetAPIVersion()
		kind := obj.GetKind()
		if apiVersion == "" || kind == "" {
			return results, fmt.Errorf("YAML document missing apiVersion or kind")
		}

		gvr, namespaced, err := s.ResolveResource(ctx, strings.ToLower(kind))
		if err != nil {
			// Try with plural forms or group
			gv, _ := schema.ParseGroupVersion(apiVersion)
			gvr, namespaced, err = s.ResolveResource(ctx, strings.ToLower(kind)+"."+gv.Group)
			if err != nil {
				return results, fmt.Errorf("resolve resource for %s/%s: %w", apiVersion, kind, err)
			}
		}

		namespace := resolveCreateNamespace(obj.GetNamespace(), defaultNamespace, namespaced)
		// 응답의 namespace 필드 + audit 등 후속 동작이 정확한 ns 를 보도록
		// 객체에도 반영. cluster-scoped 면 빈 문자열로 셋되어 무해.
		obj.SetNamespace(namespace)

		created, err := s.CreateResource(ctx, gvr, namespace, obj)
		if err != nil {
			return results, fmt.Errorf("create %s %s: %w", kind, obj.GetName(), err)
		}

		results = append(results, map[string]interface{}{
			"name":        created.GetName(),
			"namespace":   created.GetNamespace(),
			"kind":        created.GetKind(),
			"api_version": created.GetAPIVersion(),
			"message":     fmt.Sprintf("%s %s created", kind, created.GetName()),
		})
	}

	return results, nil
}
