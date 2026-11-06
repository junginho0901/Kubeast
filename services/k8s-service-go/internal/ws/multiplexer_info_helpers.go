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

// withoutPodValues is a spec for a row sent when the object does not convert. The pages read names and images from it;
// what a container is given (its environment, commands and probes), a volume's settings and a template's annotations
// stay out, as the row of an object that converts leaves them out.
func withoutPodValues(v interface{}) interface{} {
	switch t := v.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(t))
		for key, value := range t {
			switch key {
			case "containers", "initContainers", "ephemeralContainers":
				out[key] = eachMap(value, containerNames)
			case "volumes":
				out[key] = eachMap(value, volumeNames)
			case "annotations":
			default:
				out[key] = withoutPodValues(value)
			}
		}
		return out
	case []interface{}:
		out := make([]interface{}, 0, len(t))
		for _, value := range t {
			out = append(out, withoutPodValues(value))
		}
		return out
	}
	return v
}

// eachMap keeps the entries of a list that are objects, each through keep; anything else is left out.
func eachMap(v interface{}, keep func(map[string]interface{}) map[string]interface{}) []interface{} {
	list, _ := v.([]interface{})
	out := make([]interface{}, 0, len(list))
	for _, entry := range list {
		if m, ok := entry.(map[string]interface{}); ok {
			out = append(out, keep(m))
		}
	}
	return out
}

// containerNames is what a container says about itself and what it refers to, not what it is given: an env entry keeps
// its name and where it comes from.
func containerNames(c map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, key := range []string{"name", "image", "ports", "resources", "envFrom"} {
		if value, ok := c[key]; ok {
			out[key] = value
		}
	}
	if _, ok := c["env"]; ok {
		out["env"] = eachMap(c["env"], func(e map[string]interface{}) map[string]interface{} {
			return map[string]interface{}{"name": e["name"], "valueFrom": e["valueFrom"]}
		})
	}
	return out
}

// volumeNames is the ConfigMaps and Secrets a volume names.
func volumeNames(v map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{"name": v["name"]}
	for _, key := range []string{"configMap", "secret"} {
		if value, ok := v[key].(map[string]interface{}); ok {
			out[key] = map[string]interface{}{"name": value["name"], "secretName": value["secretName"]}
		}
	}
	if projected, ok := v["projected"].(map[string]interface{}); ok {
		out["projected"] = map[string]interface{}{"sources": eachMap(projected["sources"], func(s map[string]interface{}) map[string]interface{} {
			source := map[string]interface{}{}
			for _, key := range []string{"configMap", "secret"} {
				if value, ok := s[key].(map[string]interface{}); ok {
					source[key] = map[string]interface{}{"name": value["name"]}
				}
			}
			return source
		})}
	}
	return out
}

func int64Ptr(i int64) *int64 {
	return &i
}
