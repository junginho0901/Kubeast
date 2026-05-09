package ws

import (
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// objectToInfo + per-resource-kind ToInfo helpers — split out of
// multiplexer.go so that file stays focused on the WebSocket /
// subscription / watch loop. Each helper is a pure function from an
// unstructured K8s object to a frontend-shaped info map; behavior is
// identical to the pre-split code.

// objectToInfo converts an unstructured K8s object to a simplified info map.
func objectToInfo(resource string, obj *unstructured.Unstructured) map[string]interface{} {
	switch resource {
	case "pods":
		return podToInfo(obj)
	case "nodes":
		return nodeToInfo(obj)
	case "namespaces":
		return namespaceToInfo(obj)
	case "services":
		return serviceToInfo(obj)
	case "events":
		return eventToInfo(obj)
	case "deployments":
		return deploymentToInfo(obj)
	case "persistentvolumeclaims":
		return pvcToInfo(obj)
	case "persistentvolumes":
		return pvToInfo(obj)
	case "storageclasses":
		return storageclassToInfo(obj)
	case "statefulsets":
		return statefulsetToInfo(obj)
	case "daemonsets":
		return daemonsetToInfo(obj)
	case "replicasets":
		return replicasetToInfo(obj)
	case "jobs":
		return jobToInfo(obj)
	case "cronjobs":
		return cronjobToInfo(obj)
	case "ingresses":
		return ingressToInfo(obj)
	case "configmaps":
		return configmapToInfo(obj)
	case "secrets":
		return secretToInfo(obj)
	case "serviceaccounts":
		return serviceAccountToInfo(obj)
	case "roles":
		return roleToInfo(obj)
	case "horizontalpodautoscalers":
		return hpaToInfo(obj)
	case "verticalpodautoscalers":
		return vpaToInfo(obj)
	default:
		// Generic: return metadata + spec summary
		return genericToInfo(obj)
	}
}

func podToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	phase := ""
	if status != nil {
		if p, ok := status["phase"].(string); ok {
			phase = p
		}
	}

	nodeName := ""
	if spec != nil {
		if n, ok := spec["nodeName"].(string); ok {
			nodeName = n
		}
	}

	podIP := ""
	if status != nil {
		if ip, ok := status["podIP"].(string); ok {
			podIP = ip
		}
	}

	// containers / init_containers / ready / restart_count 는 frontend 가
	// PodLogsTab/PodSummaryTab 에서 사용. 이전엔 watch 응답에 빠져 있어서
	// MODIFIED 이벤트가 list 의 PodInfo 를 덮어쓰면 containers=[] 가 되고,
	// 그 pod 클릭 시 'select container' 빈칸 + 'No logs available.' stuck.
	containerStatuses := map[string]map[string]interface{}{}
	if status != nil {
		if css, ok := status["containerStatuses"].([]interface{}); ok {
			for _, cs := range css {
				csm, _ := cs.(map[string]interface{})
				if csm == nil {
					continue
				}
				name, _ := csm["name"].(string)
				if name == "" {
					continue
				}
				containerStatuses[name] = csm
			}
		}
	}

	totalReady := 0
	totalContainers := 0
	totalRestarts := int64(0)
	containers := []map[string]interface{}{}
	if spec != nil {
		if specContainers, ok := spec["containers"].([]interface{}); ok {
			for _, c := range specContainers {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				name, _ := cm["name"].(string)
				image, _ := cm["image"].(string)
				container := map[string]interface{}{
					"name":  name,
					"image": image,
				}
				if cs := containerStatuses[name]; cs != nil {
					if ready, ok := cs["ready"].(bool); ok {
						container["ready"] = ready
						if ready {
							totalReady++
						}
					}
					if rc, ok := cs["restartCount"].(int64); ok {
						container["restart_count"] = rc
						totalRestarts += rc
					} else if rc, ok := cs["restartCount"].(float64); ok {
						container["restart_count"] = int64(rc)
						totalRestarts += int64(rc)
					}
					if state, ok := cs["state"].(map[string]interface{}); ok {
						container["state"] = state
					}
				}
				containers = append(containers, container)
				totalContainers++
			}
		}
	}

	initContainers := []map[string]interface{}{}
	if spec != nil {
		if specIC, ok := spec["initContainers"].([]interface{}); ok {
			for _, c := range specIC {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				name, _ := cm["name"].(string)
				image, _ := cm["image"].(string)
				ic := map[string]interface{}{
					"name":  name,
					"image": image,
				}
				initContainers = append(initContainers, ic)
			}
		}
	}

	// container-level reason (waiting/terminated) 우선
	reason := ""
	statusReason, _ := status["reason"].(string)
	for _, cs := range containerStatuses {
		state, _ := cs["state"].(map[string]interface{})
		if state == nil {
			continue
		}
		if waiting, ok := state["waiting"].(map[string]interface{}); ok {
			if r, _ := waiting["reason"].(string); r != "" {
				reason = r
				break
			}
		}
	}
	if reason == "" {
		reason = statusReason
	}

	out := map[string]interface{}{
		"name":            metadata["name"],
		"namespace":       metadata["namespace"],
		"phase":           phase,
		"status":          phase,
		"reason":          reason,
		"status_reason":   reason,
		"node_name":       nodeName,
		"pod_ip":          podIP,
		"labels":          metadata["labels"],
		"created_at":      metadata["creationTimestamp"],
		"containers":      containers,
		"init_containers": initContainers,
		"restart_count":   totalRestarts,
		"ready":           fmt.Sprintf("%d/%d", totalReady, totalContainers),
	}
	if dt, ok := metadata["deletionTimestamp"].(string); ok && dt != "" {
		out["deletion_timestamp"] = dt
	}
	return out
}

func nodeToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	nodeStatus := "NotReady"
	if status != nil {
		if conditions, ok := status["conditions"].([]interface{}); ok {
			for _, c := range conditions {
				cm, _ := c.(map[string]interface{})
				if cm["type"] == "Ready" && cm["status"] == "True" {
					nodeStatus = "Ready"
				}
			}
		}
	}

	// Check unschedulable flag
	unschedulable := false
	if spec != nil {
		if u, ok := spec["unschedulable"].(bool); ok {
			unschedulable = u
		}
	}
	if unschedulable {
		nodeStatus += ",SchedulingDisabled"
	}

	roles := []string{}
	if labels, ok := metadata["labels"].(map[string]interface{}); ok {
		for k := range labels {
			if strings.HasPrefix(k, "node-role.kubernetes.io/") {
				role := strings.TrimPrefix(k, "node-role.kubernetes.io/")
				if role == "" {
					role = "worker"
				}
				roles = append(roles, role)
			}
		}
	}
	if len(roles) == 0 {
		roles = append(roles, "<none>")
	}

	var internalIP, externalIP string
	if status != nil {
		if addrs, ok := status["addresses"].([]interface{}); ok {
			for _, a := range addrs {
				am, _ := a.(map[string]interface{})
				if am["type"] == "InternalIP" {
					internalIP, _ = am["address"].(string)
				} else if am["type"] == "ExternalIP" {
					externalIP, _ = am["address"].(string)
				}
			}
		}
	}

	// Taints
	taints := []map[string]interface{}{}
	if spec != nil {
		if taintsList, ok := spec["taints"].([]interface{}); ok {
			for _, t := range taintsList {
				tm, _ := t.(map[string]interface{})
				if tm != nil {
					taint := map[string]interface{}{
						"key":    tm["key"],
						"effect": tm["effect"],
					}
					if v, ok := tm["value"]; ok {
						taint["value"] = v
					}
					taints = append(taints, taint)
				}
			}
		}
	}

	// Node info from status
	var osImage, kernelVersion, containerRuntime, kubeletVersion string
	if status != nil {
		if nodeInfo, ok := status["nodeInfo"].(map[string]interface{}); ok {
			osImage, _ = nodeInfo["osImage"].(string)
			kernelVersion, _ = nodeInfo["kernelVersion"].(string)
			containerRuntime, _ = nodeInfo["containerRuntimeVersion"].(string)
			kubeletVersion, _ = nodeInfo["kubeletVersion"].(string)
		}
	}

	// Conditions summary
	conditions := []map[string]interface{}{}
	if status != nil {
		if condList, ok := status["conditions"].([]interface{}); ok {
			for _, c := range condList {
				cm, _ := c.(map[string]interface{})
				if cm != nil {
					conditions = append(conditions, map[string]interface{}{
						"type":   cm["type"],
						"status": cm["status"],
						"reason": cm["reason"],
					})
				}
			}
		}
	}

	// Compute age from creationTimestamp
	ageStr := ""
	if ts, ok := metadata["creationTimestamp"].(string); ok && ts != "" {
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			d := time.Since(t)
			switch {
			case d.Hours() >= 24:
				ageStr = fmt.Sprintf("%dd", int(d.Hours()/24))
			case d.Hours() >= 1:
				ageStr = fmt.Sprintf("%dh", int(d.Hours()))
			default:
				ageStr = fmt.Sprintf("%dm", int(d.Minutes()))
			}
		}
	}

	return map[string]interface{}{
		"name":              metadata["name"],
		"status":            nodeStatus,
		"unschedulable":     unschedulable,
		"roles":             roles,
		"version":           kubeletVersion,
		"internal_ip":       internalIP,
		"external_ip":       externalIP,
		"os_image":          osImage,
		"kernel_version":    kernelVersion,
		"container_runtime": containerRuntime,
		"kubelet_version":   kubeletVersion,
		"age":               ageStr,
		"labels":            metadata["labels"],
		"taints":            taints,
		"conditions":        conditions,
		"created_at":        metadata["creationTimestamp"],
	}
}

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
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
	}
}

func serviceToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})

	svcType := ""
	clusterIP := ""
	if spec != nil {
		if t, ok := spec["type"].(string); ok {
			svcType = t
		}
		if ip, ok := spec["clusterIP"].(string); ok {
			clusterIP = ip
		}
	}

	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"type":       svcType,
		"cluster_ip": clusterIP,
		"created_at": metadata["creationTimestamp"],
	}
}

func eventToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	involvedObj := map[string]interface{}{}
	if io, ok := obj.Object["involvedObject"].(map[string]interface{}); ok {
		involvedObj = map[string]interface{}{
			"kind": io["kind"],
			"name": io["name"],
		}
	}

	return map[string]interface{}{
		"type":            obj.Object["type"],
		"reason":          obj.Object["reason"],
		"message":         obj.Object["message"],
		"namespace":       metadata["namespace"],
		"object":          involvedObj,
		"count":           obj.Object["count"],
		"first_timestamp": obj.Object["firstTimestamp"],
		"last_timestamp":  obj.Object["lastTimestamp"],
	}
}

func deploymentToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	replicas := int64(0)
	ready := int64(0)
	if spec != nil {
		if r, ok := spec["replicas"].(int64); ok {
			replicas = r
		}
	}
	if status != nil {
		if r, ok := status["readyReplicas"].(int64); ok {
			ready = r
		}
	}

	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"replicas":   replicas,
		"ready":      ready,
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
	}
}

func pvcToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	phase := "Unknown"
	if status != nil {
		if p, ok := status["phase"].(string); ok {
			phase = p
		}
	}

	var capacity interface{}
	if status != nil {
		if cap, ok := status["capacity"].(map[string]interface{}); ok {
			capacity = cap["storage"]
		}
	}

	var accessModes interface{}
	if spec != nil {
		accessModes = spec["accessModes"]
	}

	var storageClass interface{}
	if spec != nil {
		storageClass = spec["storageClassName"]
	}

	var volumeName interface{}
	if spec != nil {
		volumeName = spec["volumeName"]
	}

	return map[string]interface{}{
		"name":          metadata["name"],
		"namespace":     metadata["namespace"],
		"status":        phase,
		"capacity":      capacity,
		"access_modes":  accessModes,
		"storage_class": storageClass,
		"volume_name":   volumeName,
		"labels":        metadata["labels"],
		"created_at":    metadata["creationTimestamp"],
	}
}

func pvToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	phase := "Unknown"
	if status != nil {
		if p, ok := status["phase"].(string); ok {
			phase = p
		}
	}

	var capacity interface{}
	if spec != nil {
		if cap, ok := spec["capacity"].(map[string]interface{}); ok {
			capacity = cap["storage"]
		}
	}

	var accessModes interface{}
	if spec != nil {
		accessModes = spec["accessModes"]
	}

	var storageClass interface{}
	if spec != nil {
		storageClass = spec["storageClassName"]
	}

	var reclaimPolicy interface{}
	if spec != nil {
		reclaimPolicy = spec["persistentVolumeReclaimPolicy"]
	}

	var claimRef interface{}
	if spec != nil {
		if cr, ok := spec["claimRef"].(map[string]interface{}); ok {
			claimRef = map[string]interface{}{
				"namespace": cr["namespace"],
				"name":      cr["name"],
			}
		}
	}

	return map[string]interface{}{
		"name":           metadata["name"],
		"status":         phase,
		"capacity":       capacity,
		"access_modes":   accessModes,
		"storage_class":  storageClass,
		"reclaim_policy": reclaimPolicy,
		"claim_ref":      claimRef,
		"labels":         metadata["labels"],
		"created_at":     metadata["creationTimestamp"],
	}
}

func storageclassToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	return map[string]interface{}{
		"name":                metadata["name"],
		"provisioner":        obj.Object["provisioner"],
		"reclaim_policy":     obj.Object["reclaimPolicy"],
		"volume_binding_mode": obj.Object["volumeBindingMode"],
		"labels":             metadata["labels"],
		"created_at":         metadata["creationTimestamp"],
	}
}

func statefulsetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var replicas, readyReplicas, currentReplicas int64
	if spec != nil {
		replicas, _ = toInt64(spec["replicas"])
	}
	if status != nil {
		readyReplicas, _ = toInt64(status["readyReplicas"])
		currentReplicas, _ = toInt64(status["currentReplicas"])
	}

	return map[string]interface{}{
		"name":             metadata["name"],
		"namespace":        metadata["namespace"],
		"replicas":         replicas,
		"ready_replicas":   readyReplicas,
		"current_replicas": currentReplicas,
		"labels":           metadata["labels"],
		"created_at":       metadata["creationTimestamp"],
	}
}

func daemonsetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var desired, current, ready, available, misscheduled int64
	if status != nil {
		desired, _ = toInt64(status["desiredNumberScheduled"])
		current, _ = toInt64(status["currentNumberScheduled"])
		ready, _ = toInt64(status["numberReady"])
		available, _ = toInt64(status["numberAvailable"])
		misscheduled, _ = toInt64(status["numberMisscheduled"])
	}

	return map[string]interface{}{
		"name":          metadata["name"],
		"namespace":     metadata["namespace"],
		"desired":       desired,
		"current":       current,
		"ready":         ready,
		"available":     available,
		"misscheduled":  misscheduled,
		"labels":        metadata["labels"],
		"created_at":    metadata["creationTimestamp"],
	}
}

func replicasetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var replicas, readyReplicas, availableReplicas int64
	if spec != nil {
		replicas, _ = toInt64(spec["replicas"])
	}
	if status != nil {
		readyReplicas, _ = toInt64(status["readyReplicas"])
		availableReplicas, _ = toInt64(status["availableReplicas"])
	}

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"replicas":           replicas,
		"ready_replicas":     readyReplicas,
		"available_replicas": availableReplicas,
		"labels":             metadata["labels"],
		"created_at":         metadata["creationTimestamp"],
	}
}

func jobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var completions interface{}
	if spec != nil {
		completions = spec["completions"]
	}

	var succeeded, failed, active int64
	var startTime, completionTime interface{}
	if status != nil {
		succeeded, _ = toInt64(status["succeeded"])
		failed, _ = toInt64(status["failed"])
		active, _ = toInt64(status["active"])
		startTime = status["startTime"]
		completionTime = status["completionTime"]
	}

	var duration interface{}
	if st, ok := startTime.(string); ok && st != "" {
		if ct, ok := completionTime.(string); ok && ct != "" {
			stTime, err1 := time.Parse(time.RFC3339, st)
			ctTime, err2 := time.Parse(time.RFC3339, ct)
			if err1 == nil && err2 == nil {
				duration = int64(ctTime.Sub(stTime).Seconds())
			}
		}
	}

	return map[string]interface{}{
		"name":            metadata["name"],
		"namespace":       metadata["namespace"],
		"completions":     completions,
		"succeeded":       succeeded,
		"failed":          failed,
		"active":          active,
		"start_time":      startTime,
		"completion_time": completionTime,
		"duration":        duration,
		"labels":          metadata["labels"],
		"created_at":      metadata["creationTimestamp"],
	}
}

func cronjobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var schedule interface{}
	var suspend bool
	if spec != nil {
		schedule = spec["schedule"]
		if s, ok := spec["suspend"].(bool); ok {
			suspend = s
		}
	}

	var activeCount int
	var lastScheduleTime interface{}
	if status != nil {
		if activeList, ok := status["active"].([]interface{}); ok {
			activeCount = len(activeList)
		}
		lastScheduleTime = status["lastScheduleTime"]
	}

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"schedule":           schedule,
		"suspend":            suspend,
		"active":             activeCount,
		"last_schedule_time": lastScheduleTime,
		"labels":             metadata["labels"],
		"created_at":         metadata["creationTimestamp"],
	}
}

func ingressToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var ingressClass interface{}
	if spec != nil {
		ingressClass = spec["ingressClassName"]
	}

	var hosts []string
	if spec != nil {
		if rules, ok := spec["rules"].([]interface{}); ok {
			for _, r := range rules {
				if rm, ok := r.(map[string]interface{}); ok {
					if host, ok := rm["host"].(string); ok {
						hosts = append(hosts, host)
					}
				}
			}
		}
	}

	var loadBalancer interface{}
	if status != nil {
		if lb, ok := status["loadBalancer"].(map[string]interface{}); ok {
			if ingress, ok := lb["ingress"].([]interface{}); ok && len(ingress) > 0 {
				if first, ok := ingress[0].(map[string]interface{}); ok {
					if ip, ok := first["ip"].(string); ok {
						loadBalancer = ip
					} else if hostname, ok := first["hostname"].(string); ok {
						loadBalancer = hostname
					}
				}
			}
		}
	}

	return map[string]interface{}{
		"name":          metadata["name"],
		"namespace":     metadata["namespace"],
		"class":         ingressClass,
		"rules":         hosts,
		"load_balancer": loadBalancer,
		"labels":        metadata["labels"],
		"created_at":    metadata["creationTimestamp"],
	}
}

func configmapToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	dataCount := 0
	if data, ok := obj.Object["data"].(map[string]interface{}); ok {
		dataCount = len(data)
	}

	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"data_count": dataCount,
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
	}
}

func secretToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	secretType := ""
	if t, ok := obj.Object["type"].(string); ok {
		secretType = t
	}

	dataCount := 0
	if data, ok := obj.Object["data"].(map[string]interface{}); ok {
		dataCount = len(data)
	}

	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"type":       secretType,
		"data_count": dataCount,
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
	}
}

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

func serviceAccountToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	secrets, _ := obj.Object["secrets"].([]interface{})
	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"secrets":    len(secrets),
		"created_at": metadata["creationTimestamp"],
		"labels":     metadata["labels"],
		"annotations": metadata["annotations"],
	}
}

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

func genericToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})
	// 명시적 *ToInfo 가 없는 리소스 (endpoints, gateways, networkpolicies,
	// volumeattachments 등) 의 fallback. metadata 만 보내면 frontend 의
	// normalize 가 status/capacity 등을 'Unknown'/null 로 fallback 처리해
	// list 의 정상 데이터를 watch event 로 덮어쓰는 버그 발생.
	// raw K8s spec/status 통째로 포함 → frontend 의 normalize 가 raw K8s
	// 형태 처리 경로 (metadata.x ?? obj.x, status.phase 등) 로 정상 추출.
	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"kind":       obj.GetKind(),
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
		"spec":       spec,
		"status":     status,
	}
}

func hpaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	targetRef := ""
	targetRefKind := ""
	targetRefName := ""
	if ref, ok := spec["scaleTargetRef"].(map[string]interface{}); ok {
		targetRefKind, _ = ref["kind"].(string)
		targetRefName, _ = ref["name"].(string)
		targetRef = targetRefKind + "/" + targetRefName
	}

	maxReplicas, _ := spec["maxReplicas"].(int64)
	var minReplicas interface{}
	if mr, ok := spec["minReplicas"].(int64); ok {
		minReplicas = mr
	}

	var currentReplicas, desiredReplicas interface{}
	if status != nil {
		if cr, ok := status["currentReplicas"].(int64); ok {
			currentReplicas = cr
		}
		if dr, ok := status["desiredReplicas"].(int64); ok {
			desiredReplicas = dr
		}
	}

	return map[string]interface{}{
		"name":             metadata["name"],
		"namespace":        metadata["namespace"],
		"target_ref":       targetRef,
		"target_ref_kind":  targetRefKind,
		"target_ref_name":  targetRefName,
		"min_replicas":     minReplicas,
		"max_replicas":     maxReplicas,
		"current_replicas": currentReplicas,
		"desired_replicas": desiredReplicas,
		"labels":           metadata["labels"],
		"created_at":       metadata["creationTimestamp"],
	}
}

func vpaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	targetRef := ""
	targetRefKind := ""
	targetRefName := ""
	if ref, ok := spec["targetRef"].(map[string]interface{}); ok {
		targetRefKind, _ = ref["kind"].(string)
		targetRefName, _ = ref["name"].(string)
		targetRef = targetRefKind + "/" + targetRefName
	}

	updateMode := ""
	if up, ok := spec["updatePolicy"].(map[string]interface{}); ok {
		updateMode, _ = up["updateMode"].(string)
	}

	cpuTarget := ""
	memoryTarget := ""
	provided := ""

	if status != nil {
		if conditions, ok := status["conditions"].([]interface{}); ok && len(conditions) > 0 {
			if c, ok := conditions[0].(map[string]interface{}); ok {
				provided, _ = c["status"].(string)
			}
		}
		if recommendation, ok := status["recommendation"].(map[string]interface{}); ok {
			if containerRecs, ok := recommendation["containerRecommendations"].([]interface{}); ok && len(containerRecs) > 0 {
				if rec, ok := containerRecs[0].(map[string]interface{}); ok {
					if target, ok := rec["target"].(map[string]interface{}); ok {
						cpuTarget, _ = target["cpu"].(string)
						memoryTarget, _ = target["memory"].(string)
					}
				}
			}
		}
	}

	return map[string]interface{}{
		"name":            metadata["name"],
		"namespace":       metadata["namespace"],
		"target_ref":      targetRef,
		"target_ref_kind": targetRefKind,
		"target_ref_name": targetRefName,
		"update_mode":     updateMode,
		"cpu_target":      cpuTarget,
		"memory_target":   memoryTarget,
		"provided":        provided,
		"labels":          metadata["labels"],
		"created_at":      metadata["creationTimestamp"],
	}
}

func int64Ptr(i int64) *int64 {
	return &i
}
