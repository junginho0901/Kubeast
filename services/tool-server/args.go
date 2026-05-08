// 도구 호출 args 파서. main.go 에서 추출 (Phase 3.6.b).
//
// MCP/REST 의 args (map[string]interface{}) 에서 string/bool/int/slice/map
// 형태로 안전하게 꺼내는 헬퍼들. 추가로 manifest/patch 본문을 여러 alias
// (yaml_content / manifest / resource_manifest) 중 하나에서 꺼내는 helper 도
// 동거 — write tool 들이 공통으로 쓰는 입력 가공.

package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

func argString(args map[string]interface{}, key, def string) string {
	if args == nil {
		return def
	}
	val, ok := args[key]
	if !ok || val == nil {
		return def
	}
	switch v := val.(type) {
	case string:
		if v == "" {
			return def
		}
		return v
	default:
		return fmt.Sprint(v)
	}
}

func argBool(args map[string]interface{}, key string) bool {
	if args == nil {
		return false
	}
	val, ok := args[key]
	if !ok || val == nil {
		return false
	}
	switch v := val.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(strings.TrimSpace(v), "true")
	case json.Number:
		return v.String() == "1"
	case float64:
		return v != 0
	case int:
		return v != 0
	default:
		return false
	}
}

func argInt(args map[string]interface{}, key string, def int) int {
	if args == nil {
		return def
	}
	val, ok := args[key]
	if !ok || val == nil {
		return def
	}
	switch v := val.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		i, err := strconv.Atoi(v.String())
		if err != nil {
			return def
		}
		return i
	case string:
		i, err := strconv.Atoi(v)
		if err != nil {
			return def
		}
		return i
	default:
		return def
	}
}

func argStringSlice(args map[string]interface{}, key string) []string {
	if args == nil {
		return nil
	}
	val, ok := args[key]
	if !ok || val == nil {
		return nil
	}
	switch v := val.(type) {
	case []string:
		return v
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if item == nil {
				continue
			}
			s := strings.TrimSpace(fmt.Sprint(item))
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		raw := strings.TrimSpace(v)
		if raw == "" {
			return nil
		}
		parts := strings.Split(raw, ",")
		if len(parts) == 1 {
			return strings.Fields(raw)
		}
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			s := strings.TrimSpace(p)
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func argStringMap(args map[string]interface{}, key string) map[string]string {
	if args == nil {
		return nil
	}
	val, ok := args[key]
	if !ok || val == nil {
		return nil
	}
	switch v := val.(type) {
	case map[string]string:
		return v
	case map[string]interface{}:
		out := make(map[string]string, len(v))
		for k, raw := range v {
			if k == "" || raw == nil {
				continue
			}
			out[k] = fmt.Sprint(raw)
		}
		return out
	default:
		return nil
	}
}

func manifestFromArgs(args map[string]interface{}) (string, error) {
	if args == nil {
		return "", wrapBadRequest("resource_manifest or yaml_content is required")
	}
	if v, ok := args["yaml_content"]; ok && v != nil {
		raw := strings.TrimSpace(fmt.Sprint(v))
		if raw != "" {
			return raw, nil
		}
	}
	if v, ok := args["manifest"]; ok && v != nil {
		raw := strings.TrimSpace(fmt.Sprint(v))
		if raw != "" {
			return raw, nil
		}
	}
	if v, ok := args["resource_manifest"]; ok && v != nil {
		switch typed := v.(type) {
		case string:
			raw := strings.TrimSpace(typed)
			if raw != "" {
				return raw, nil
			}
		default:
			data, err := json.Marshal(typed)
			if err != nil {
				return "", err
			}
			return string(data), nil
		}
	}
	return "", wrapBadRequest("resource_manifest or yaml_content is required")
}

func patchFromArgs(args map[string]interface{}) (string, error) {
	if args == nil {
		return "", wrapBadRequest("patch parameter is required")
	}
	for _, key := range []string{"patch", "patch_content", "patch_body"} {
		if v, ok := args[key]; ok && v != nil {
			switch typed := v.(type) {
			case string:
				raw := strings.TrimSpace(typed)
				if raw == "" {
					break
				}
				return raw, nil
			default:
				data, err := json.Marshal(typed)
				if err != nil {
					return "", err
				}
				return string(data), nil
			}
		}
	}
	return "", wrapBadRequest("patch parameter is required")
}
