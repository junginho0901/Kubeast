package ws

// Shared helpers used by the various *ToInfo functions in sibling files
// (multiplexer_info_*.go). int64Ptr is also referenced by multiplexer.go.

// toInt64 converts various numeric types from unstructured JSON to int64.
func toInt64(v interface{}) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case float64:
		return int64(n), true
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	default:
		return 0, false
	}
}

// containerImages — spec.template.spec.containers[].image 추출 (deployment/sts/ds/rs).
func containerImages(spec map[string]interface{}) []string {
	images := []string{}
	if spec == nil {
		return images
	}
	tmpl, ok := spec["template"].(map[string]interface{})
	if !ok {
		return images
	}
	podSpec, ok := tmpl["spec"].(map[string]interface{})
	if !ok {
		return images
	}
	containers, ok := podSpec["containers"].([]interface{})
	if !ok {
		return images
	}
	for _, c := range containers {
		cm, _ := c.(map[string]interface{})
		if cm == nil {
			continue
		}
		if img, ok := cm["image"].(string); ok {
			images = append(images, img)
		}
	}
	return images
}

// containerImagesFromTemplate — JobSpec / CronJobSpec 등의 spec.template.spec.containers
// 추출 (containerImages 와 동일하지만 이미 podTemplateSpec 인 spec 을 받음).
func containerImagesFromTemplate(spec map[string]interface{}) []string {
	return containerImages(spec)
}

// selectorMatchLabels — spec.selector.matchLabels 추출, 없으면 빈 map.
func selectorMatchLabels(spec map[string]interface{}) interface{} {
	if spec == nil {
		return map[string]string{}
	}
	sel, ok := spec["selector"].(map[string]interface{})
	if !ok {
		return map[string]string{}
	}
	if ml, ok := sel["matchLabels"].(map[string]interface{}); ok {
		return ml
	}
	return map[string]string{}
}

// containerStateStrFromMap — formatPodDetail 의 containerStateStr 와 동일 logic.
// state map ({waiting/running/terminated} 중 하나) 을 단일 string 으로 직렬화.
func containerStateStrFromMap(v interface{}) string {
	state, ok := v.(map[string]interface{})
	if !ok || state == nil {
		return ""
	}
	if w, ok := state["waiting"].(map[string]interface{}); ok && w != nil {
		if r, _ := w["reason"].(string); r != "" {
			return r
		}
		return "Waiting"
	}
	if _, ok := state["running"].(map[string]interface{}); ok {
		return "Running"
	}
	if t, ok := state["terminated"].(map[string]interface{}); ok && t != nil {
		if r, _ := t["reason"].(string); r != "" {
			return r
		}
		return "Terminated"
	}
	return ""
}

// strOrEmpty — interface{} 가 string 이면 그대로, 아니면 빈 string.
func strOrEmpty(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// sortStrings — 외부 패키지 import 없이 쓸 수 있게 작은 insertion sort.
// formatIngressDetail 이 sort.Strings(backends) 호출하므로 동일 결과 보장.
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

func int64Ptr(i int64) *int64 {
	return &i
}
