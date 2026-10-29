package handler

import "testing"

func secretObj(name string) map[string]interface{} {
	return map[string]interface{}{
		"apiVersion": "v1", "kind": "Secret",
		"metadata": map[string]interface{}{"name": name, "annotations": map[string]interface{}{
			"kubectl.kubernetes.io/last-applied-configuration": `{"data":{"password":"aHVudGVyMg=="}}`,
			"owner": "team-a",
		}},
		"data":       map[string]interface{}{"password": "aHVudGVyMg==", "user": "YWRtaW4="},
		"stringData": map[string]interface{}{"note": "plain"},
	}
}

func TestMaskSecretValues(t *testing.T) {
	s := secretObj("db")
	if !maskSecretValues(s) {
		t.Fatal("a Secret must be masked")
	}
	data := s["data"].(map[string]interface{})
	if data["password"] != secretMask || data["user"] != secretMask {
		t.Fatalf("data not masked: %v", data)
	}
	if s["stringData"].(map[string]interface{})["note"] != secretMask {
		t.Fatalf("stringData not masked")
	}
	ann := s["metadata"].(map[string]interface{})["annotations"].(map[string]interface{})
	if ann["kubectl.kubernetes.io/last-applied-configuration"] != secretMask || ann["owner"] != "team-a" {
		t.Fatalf("last-applied must be masked and other annotations kept: %v", ann)
	}

	cm := map[string]interface{}{"kind": "ConfigMap", "data": map[string]interface{}{"k": "v"}}
	if maskSecretValues(cm) || cm["data"].(map[string]interface{})["k"] != "v" {
		t.Fatal("a ConfigMap must be left alone")
	}
	if maskSecretValues(nil) {
		t.Fatal("nil")
	}
}
