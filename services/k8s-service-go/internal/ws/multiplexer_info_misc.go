package ws

import (
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// namespaceToInfo — list endpoint: GetNamespaces inline (namespaces.go).
func namespaceToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	phase := ""
	if status != nil {
		if p, ok := status["phase"].(string); ok {
			phase = p
		}
	}

	return map[string]interface{}{
		"name":       metadata["name"],
		"status":     phase,
		"created_at": metadata["creationTimestamp"],
		"labels":     metadata["labels"],
	}
}

// serviceToInfo — list endpoint: formatServiceDetail (services.go).
func serviceToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	svcType := ""
	clusterIP := ""
	var selector interface{}
	if spec != nil {
		if t, ok := spec["type"].(string); ok {
			svcType = t
		}
		if ip, ok := spec["clusterIP"].(string); ok {
			clusterIP = ip
		}
		selector = spec["selector"]
	}

	// ports
	ports := []map[string]interface{}{}
	if spec != nil {
		if rawPorts, ok := spec["ports"].([]interface{}); ok {
			for _, p := range rawPorts {
				pm, _ := p.(map[string]interface{})
				if pm == nil {
					continue
				}
				port := map[string]interface{}{}
				if pn, ok := pm["name"].(string); ok {
					port["name"] = pn
				} else {
					port["name"] = ""
				}
				if pv, ok := toInt64(pm["port"]); ok {
					port["port"] = pv
				}
				// target_port 은 string 으로 직렬화 (intstr)
				if tp, ok := pm["targetPort"]; ok {
					switch v := tp.(type) {
					case string:
						port["target_port"] = v
					case int64:
						port["target_port"] = fmt.Sprintf("%d", v)
					case float64:
						port["target_port"] = fmt.Sprintf("%d", int64(v))
					default:
						port["target_port"] = fmt.Sprintf("%v", v)
					}
				} else {
					port["target_port"] = ""
				}
				if pp, ok := pm["protocol"].(string); ok {
					port["protocol"] = pp
				} else {
					port["protocol"] = ""
				}
				if np, ok := toInt64(pm["nodePort"]); ok && np > 0 {
					port["node_port"] = np
				}
				if ap, ok := pm["appProtocol"].(string); ok && ap != "" {
					port["app_protocol"] = ap
				}
				ports = append(ports, port)
			}
		}
	}

	// external_ip — formatServiceDetail 과 동일 logic
	externalIPs := []string{}
	if spec != nil {
		if eips, ok := spec["externalIPs"].([]interface{}); ok {
			for _, ip := range eips {
				if s, ok := ip.(string); ok {
					externalIPs = append(externalIPs, s)
				}
			}
		}
	}
	if svcType == "LoadBalancer" && status != nil {
		if lb, ok := status["loadBalancer"].(map[string]interface{}); ok {
			if ingressList, ok := lb["ingress"].([]interface{}); ok {
				for _, ing := range ingressList {
					ingm, _ := ing.(map[string]interface{})
					if ingm == nil {
						continue
					}
					if ip, ok := ingm["ip"].(string); ok && ip != "" {
						externalIPs = append(externalIPs, ip)
					}
					if hn, ok := ingm["hostname"].(string); ok && hn != "" {
						externalIPs = append(externalIPs, hn)
					}
				}
			}
		}
	}
	externalIP := "<none>"
	if len(externalIPs) > 0 {
		externalIP = strings.Join(externalIPs, ",")
	}

	return map[string]interface{}{
		"name":        metadata["name"],
		"namespace":   metadata["namespace"],
		"type":        svcType,
		"cluster_ip":  clusterIP,
		"external_ip": externalIP,
		"ports":       ports,
		"selector":    selector,
		"created_at":  metadata["creationTimestamp"],
	}
}

// eventToInfo — list endpoint: GetEvents inline (events.go).
func eventToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	involved := map[string]interface{}{}
	if io, ok := obj.Object["involvedObject"].(map[string]interface{}); ok {
		involved = map[string]interface{}{
			"kind":      io["kind"],
			"name":      io["name"],
			"namespace": io["namespace"],
		}
	}

	source := map[string]interface{}{
		"component": nil,
		"host":      nil,
	}
	if src, ok := obj.Object["source"].(map[string]interface{}); ok {
		source["component"] = src["component"]
		source["host"] = src["host"]
	}

	reportingComponent := ""
	if rc, ok := obj.Object["reportingComponent"].(string); ok {
		reportingComponent = rc
	}

	return map[string]interface{}{
		"name":                metadata["name"],
		"namespace":           metadata["namespace"],
		"type":                obj.Object["type"],
		"reason":              obj.Object["reason"],
		"message":             obj.Object["message"],
		"count":               obj.Object["count"],
		"first_timestamp":     obj.Object["firstTimestamp"],
		"last_timestamp":      obj.Object["lastTimestamp"],
		"reporting_component": reportingComponent,
		"involved_object":     involved,
		"source":              source,
		"created_at":          metadata["creationTimestamp"],
	}
}

// genericToInfo — explicit *ToInfo 가 없는 fallback. metadata 만 보내면
// frontend normalize 가 status/capacity 등을 'Unknown'/null 로 fallback 처리해
// list 의 정상 데이터를 watch event 로 덮어쓰는 버그가 발생.
// raw spec/status 통째로 포함 → frontend 의 normalize 가 raw K8s 형태 처리
// 경로 (metadata.x ?? obj.x, status.phase 등) 로 정상 추출.
func genericToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})
	out := map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"kind":       obj.GetKind(),
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
		"spec":       spec,
		"status":     status,
	}
	// metadata 전체를 통과시키지 않으므로 ownerReferences 가 누락됨. 명시적
	// 노출 — ResourceClaimTemplate-owned RC 같은 reverse-lookup watch 시 필요.
	if ors, ok := metadata["ownerReferences"].([]interface{}); ok && len(ors) > 0 {
		refs := make([]map[string]interface{}, 0, len(ors))
		for _, r := range ors {
			rm, _ := r.(map[string]interface{})
			if rm == nil {
				continue
			}
			ctrl, _ := rm["controller"].(bool)
			refs = append(refs, map[string]interface{}{
				"kind":       rm["kind"],
				"name":       rm["name"],
				"uid":        rm["uid"],
				"controller": ctrl,
			})
		}
		out["owner_references"] = refs
	}
	return out
}
