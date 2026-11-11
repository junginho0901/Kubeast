package k8s

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
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

// ApplyResourceYAML patches a resource with a whole YAML document: what the document does not name stays.
func (s *Service) ApplyResourceYAML(ctx context.Context, resourceType, namespace, name, yamlStr string) (map[string]interface{}, error) {
	return s.applyResourceYAML(ctx, resourceType, namespace, name, "", yamlStr, nil)
}

// ApplyEditedYAML is ApplyResourceYAML for a save that says what text its edit began from, as the YAML windows do: a line
// taken out of that text is taken out of the object (editedPatch). Without one it is ApplyResourceYAML.
func (s *Service) ApplyEditedYAML(ctx context.Context, resourceType, namespace, name, opened, yamlStr string) (map[string]interface{}, error) {
	return s.applyResourceYAML(ctx, resourceType, namespace, name, opened, yamlStr, nil)
}

// ApplySecretYAMLWithoutReveal is ApplyEditedYAML for a Secret's editor who was shown its values as the mask: a mask
// stands for the value it hides, and a merge patch leaves what it does not name, so each one is left out of the patch
// and that value stays. It also names them, as the answer's kept_masked does.
func (s *Service) ApplySecretYAMLWithoutReveal(ctx context.Context, resourceType, namespace, name, opened, yamlStr string) (map[string]interface{}, []string, error) {
	var kept []string
	answer, err := s.applyResourceYAML(ctx, resourceType, namespace, name, opened, yamlStr, func(object, before map[string]interface{}) {
		kept = takeSecretMasks(object, before)
	})
	if err == nil && len(kept) > 0 {
		answer["kept_masked"] = kept
	}
	return answer, kept, err
}

// isSecretDataMask: whether a value under a Secret's data is the mask, as it reads or in the base64 the YAML window makes
// of a line it shows under stringData; a window opened before it read YAML's quotes saves them too.
func isSecretDataMask(value interface{}) bool {
	text, ok := value.(string)
	if !ok {
		return false
	}
	if text == SecretMask {
		return true
	}
	decoded, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return false
	}
	switch string(decoded) {
	case SecretMask, "'" + SecretMask + "'", `"` + SecretMask + `"`:
		return true
	}
	return false
}

// takeSecretMasks removes the masks from a Secret written as YAML and names what it removed; keys and fields only, which
// a caller without reveal reads anyway. With the text the edit began from it takes them from that too, so a value whose
// mask stayed is no difference, and leaves a section it emptied in place: the section gone would read as all its keys taken out.
func takeSecretMasks(object, before map[string]interface{}) []string {
	var taken []string
	take := func(section string, isMask func(interface{}) bool) {
		values, ok := object[section].(map[string]interface{})
		if !ok {
			return
		}
		opened, _ := before[section].(map[string]interface{})
		for _, key := range sortedKeys(values) {
			if isMask(values[key]) {
				delete(values, key)
				delete(opened, key)
				taken = append(taken, section+"."+key)
			}
		}
		if len(values) == 0 && before == nil {
			delete(object, section)
		}
	}
	take("data", isSecretDataMask)
	take("stringData", func(value interface{}) bool { return value == SecretMask })
	if metadata, ok := object["metadata"].(map[string]interface{}); ok {
		if annotations, ok := metadata["annotations"].(map[string]interface{}); ok && annotations[lastAppliedAnnotation] == SecretMask {
			delete(annotations, lastAppliedAnnotation)
			if openedMetadata, ok := before["metadata"].(map[string]interface{}); ok {
				if opened, ok := openedMetadata["annotations"].(map[string]interface{}); ok {
					delete(opened, lastAppliedAnnotation)
				}
			}
			taken = append(taken, "metadata.annotations."+lastAppliedAnnotation)
		}
	}
	return taken
}

// YAMLSecretMasks names the masks in the core Secrets a create would make, each by its object: a new Secret has no value
// for one to stand for. Documents past one that cannot be read are the create's to report.
func YAMLSecretMasks(yamlStr string) []string {
	decoder := yaml.NewDecoder(bufio.NewReader(bytes.NewBufferString(yamlStr)))
	var out []string
	for {
		var document map[string]interface{}
		if err := decoder.Decode(&document); err != nil {
			return out
		}
		if document["kind"] != "Secret" || document["apiVersion"] != "v1" {
			continue
		}
		metadata, _ := document["metadata"].(map[string]interface{})
		for _, field := range takeSecretMasks(document, nil) {
			out = append(out, fmt.Sprintf("%v %s", metadata["name"], field))
		}
	}
}

func (s *Service) applyResourceYAML(ctx context.Context, resourceType, namespace, name, opened, yamlStr string, prepare func(object, before map[string]interface{})) (map[string]interface{}, error) {
	match, err := s.resolveResourceMatch(ctx, resourceType)
	if err != nil {
		return nil, err
	}
	gvr := match.gvr
	gvk := gvr.GroupVersion().WithKind(match.kind)

	ns := namespace
	if !match.namespaced {
		ns = ""
	}

	// Parse YAML to JSON for the patch
	// an emptied window would go as a patch of nothing and answer "updated"
	object, err := editedObject(yamlStr)
	if err != nil {
		return nil, err
	}
	before := openedObject(opened)
	// the version the window was opened at: a patch the API server took without a write leaves it as it was
	sentVersion := nestedString(object, "metadata", "resourceVersion")
	if prepare != nil {
		prepare(object, before)
	}

	var patchType types.PatchType
	var patchData []byte
	if before != nil && len(object) > 0 {
		patchType, patchData, err = editedPatch(gvk, before, object)
		if err != nil {
			return nil, err
		}
	} else {
		// A window left with no object in it takes nothing out: a difference would name every line.
		patchType = patchTypeOf(gvk)
		patchData, err = json.Marshal(object)
		if err != nil {
			return nil, badInput("the YAML has a field whose name is not text")
		}
	}

	var patched *unstructured.Unstructured
	if ns != "" {
		patched, err = s.dynamicCtx(ctx).Resource(gvr).Namespace(ns).Patch(ctx, name, patchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	} else {
		patched, err = s.dynamicCtx(ctx).Resource(gvr).Patch(ctx, name, patchType, patchData, metav1.PatchOptions{FieldManager: "k8s-service"})
	}
	if err != nil {
		return nil, fmt.Errorf("patch %s %s: %w", resourceType, name, err)
	}

	s.dropCached(ctx, fmt.Sprintf("yaml|%s|%s|%s", gvr.Resource, ns, name))

	// kubectl apply's "unchanged": the object is at the version the window held, so this patch wrote nothing. A version
	// that moved may be another writer's, so that reads as updated.
	unchanged := sentVersion != "" && patched.GetResourceVersion() == sentVersion
	message := fmt.Sprintf("%s %s updated", resourceType, name)
	if unchanged {
		message = fmt.Sprintf("%s %s unchanged", resourceType, name)
	}
	return map[string]interface{}{
		"name":        patched.GetName(),
		"namespace":   patched.GetNamespace(),
		"kind":        patched.GetKind(),
		"api_version": patched.GetAPIVersion(),
		"message":     message,
		"unchanged":   unchanged,
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
	if err == nil && len(results) == 0 {
		// comments, separators or empty documents only: kubectl's "no objects passed to create", not a create of nothing
		return nil, badInput("no objects passed to create: the YAML holds only comments or empty documents")
	}
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

	for doc := 1; ; doc++ {
		var rawObj map[string]interface{}
		err := decoder.Decode(&rawObj)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return yamlReadError(doc, err)
		}
		if rawObj == nil {
			continue
		}

		// Convert to JSON for the unstructured object
		jsonData, err := json.Marshal(rawObj)
		if err != nil {
			return badInput("document %d has a field whose name is not text", doc)
		}

		obj := &unstructured.Unstructured{}
		if err := json.Unmarshal(jsonData, &obj.Object); err != nil {
			return fmt.Errorf("unmarshal to unstructured: %w", err)
		}

		// Resolve the GVR from the object's apiVersion and kind
		apiVersion, _ := obj.Object["apiVersion"].(string)
		kind, _ := obj.Object["kind"].(string)
		if apiVersion == "" || kind == "" {
			return badInput("document %d: %s", doc, missingTypeFields(apiVersion, kind))
		}

		gvr, namespaced, err := s.ResolveKind(ctx, apiVersion, kind)
		if err != nil {
			if errors.Is(err, ErrBadInput) {
				return badInput("document %d: %s", doc, err)
			}
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
