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

func TestMaskSecretList(t *testing.T) {
	typed := map[string]interface{}{"items": []map[string]interface{}{secretObj("a"), {"kind": "ConfigMap", "data": map[string]interface{}{"k": "v"}}, secretObj("b")}}
	if n := maskSecretList(typed); n != 2 {
		t.Fatalf("typed list: masked %d, want 2", n)
	}
	for _, it := range typed["items"].([]map[string]interface{}) {
		if it["kind"] == "Secret" && it["data"].(map[string]interface{})["password"] != secretMask {
			t.Fatalf("item not masked: %v", it)
		}
	}
	generic := map[string]interface{}{"items": []interface{}{secretObj("c"), map[string]interface{}{"kind": "Pod"}}}
	if n := maskSecretList(generic); n != 1 {
		t.Fatalf("generic list: masked %d, want 1", n)
	}
	if maskSecretList(nil) != 0 || maskSecretList(map[string]interface{}{}) != 0 {
		t.Fatal("empty")
	}
}
