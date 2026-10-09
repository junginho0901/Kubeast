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

// containerNamesFromTemplate — spec.template.spec.containers[].name (list rows
// carry `containers` next to `images`).
func containerNamesFromTemplate(spec map[string]interface{}) []string {
	names := []string{}
	if spec == nil {
		return names
	}
	tmpl, ok := spec["template"].(map[string]interface{})
	if !ok {
		return names
	}
	podSpec, ok := tmpl["spec"].(map[string]interface{})
	if !ok {
		return names
	}
	containers, ok := podSpec["containers"].([]interface{})
	if !ok {
		return names
	}
	for _, c := range containers {
		cm, _ := c.(map[string]interface{})
		if cm == nil {
			continue
		}
		if name, ok := cm["name"].(string); ok {
			names = append(names, name)
		}
	}
	return names
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

// containerStateFromMap — the same shape as containerStateStr in the list
// endpoint (pods_format.go): {running|waiting|terminated: {...}} in snake_case.
func containerStateFromMap(v interface{}) map[string]interface{} {
	result := map[string]interface{}{}
	state, _ := v.(map[string]interface{})
	if r, ok := state["running"].(map[string]interface{}); ok {
		result["running"] = map[string]interface{}{"started_at": strOrEmpty(r["startedAt"])}
	}
	if w, ok := state["waiting"].(map[string]interface{}); ok {
		result["waiting"] = map[string]interface{}{
			"reason":  strOrEmpty(w["reason"]),
			"message": strOrEmpty(w["message"]),
		}
	}
	if t, ok := state["terminated"].(map[string]interface{}); ok {
		exitCode, _ := toInt64(t["exitCode"])
		result["terminated"] = map[string]interface{}{
			"exit_code":   exitCode,
			"reason":      strOrEmpty(t["reason"]),
			"message":     strOrEmpty(t["message"]),
			"started_at":  strOrEmpty(t["startedAt"]),
			"finished_at": strOrEmpty(t["finishedAt"]),
		}
	}
	return result
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
