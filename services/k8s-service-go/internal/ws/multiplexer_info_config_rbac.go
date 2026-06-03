package ws

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// configmapToInfo — list endpoint: GetConfigMaps inline (configmaps.go).
func configmapToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	dataKeys := []string{}
	dataCount := 0
	if data, ok := obj.Object["data"].(map[string]interface{}); ok {
		dataCount = len(data)
		for k := range data {
			dataKeys = append(dataKeys, k)
		}
	}

	binaryKeys := []string{}
	if bd, ok := obj.Object["binaryData"].(map[string]interface{}); ok {
		for k := range bd {
			binaryKeys = append(binaryKeys, k)
		}
	}

	return map[string]interface{}{
		"name":        metadata["name"],
		"namespace":   metadata["namespace"],
		"data_count":  dataCount,
		"data_keys":   dataKeys,
		"binary_keys": binaryKeys,
		"labels":      metadata["labels"],
		"created_at":  metadata["creationTimestamp"],
	}
}

// secretToInfo — list endpoint: GetSecrets inline (configmaps.go).
func secretToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	secretType := ""
	if t, ok := obj.Object["type"].(string); ok {
		secretType = t
	}

	dataKeys := []string{}
	dataCount := 0
	if data, ok := obj.Object["data"].(map[string]interface{}); ok {
		dataCount = len(data)
		for k := range data {
			dataKeys = append(dataKeys, k)
		}
	}

	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"type":       secretType,
		"data_count": dataCount,
		"data_keys":  dataKeys,
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
	}
}

// serviceAccountToInfo — list endpoint: formatServiceAccountList (security_serviceaccount.go).
// Secret detail 의 "Used By ServiceAccounts" watch 가 obj.secrets_list /
// obj.image_pull_secrets 두 string array 를 검사하므로 backend list formatter
// 와 동일 shape 로 노출.
func serviceAccountToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	rawSecrets, _ := obj.Object["secrets"].([]interface{})
	rawIPS, _ := obj.Object["imagePullSecrets"].([]interface{})

	secretsList := make([]string, 0, len(rawSecrets))
	for _, s := range rawSecrets {
		sm, _ := s.(map[string]interface{})
		if sm == nil {
			continue
		}
		if n, _ := sm["name"].(string); n != "" {
			secretsList = append(secretsList, n)
		}
	}
	imagePullSecrets := make([]string, 0, len(rawIPS))
	for _, s := range rawIPS {
		sm, _ := s.(map[string]interface{})
		if sm == nil {
			continue
		}
		if n, _ := sm["name"].(string); n != "" {
			imagePullSecrets = append(imagePullSecrets, n)
		}
	}

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"secrets":            len(rawSecrets),
		"secrets_list":       secretsList,
		"image_pull_secrets": imagePullSecrets,
		"created_at":         metadata["creationTimestamp"],
		"labels":             metadata["labels"],
		"annotations":        metadata["annotations"],
	}
}

// roleToInfo — list endpoint: formatRoleList (security.go).
func roleToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	rules, _ := obj.Object["rules"].([]interface{})
	return map[string]interface{}{
		"name":        metadata["name"],
		"namespace":   metadata["namespace"],
		"rules_count": len(rules),
		"created_at":  metadata["creationTimestamp"],
		"labels":      metadata["labels"],
		"annotations": metadata["annotations"],
	}
}
