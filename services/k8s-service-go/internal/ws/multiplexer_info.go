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
// unstructured K8s object to a frontend-shaped info map.
//
// IMPORTANT: 각 *ToInfo 의 반환 keys 는 internal/k8s 의 list endpoint
// (formatXxxDetail / inline list 코드) 와 **반드시 동일** 해야 한다.
// 두 응답이 frontend cache 에서 같은 queryKey 를 공유하므로 watch
// event 가 list 의 정상 항목을 부분 데이터로 덮어쓰면 새로고침 시
// statefulset/deployment 등에서 데이터 사라짐 / 일부만 표시 회귀 발생.

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

// podToInfo — list endpoint: formatPodDetail (pods.go).
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

	// containerStatuses 인덱싱 (name → status map)
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
	initContainerStatuses := map[string]map[string]interface{}{}
	if status != nil {
		if css, ok := status["initContainerStatuses"].([]interface{}); ok {
			for _, cs := range css {
				csm, _ := cs.(map[string]interface{})
				if csm == nil {
					continue
				}
				name, _ := csm["name"].(string)
				if name == "" {
					continue
				}
				initContainerStatuses[name] = csm
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

				// ports
				ports := []map[string]interface{}{}
				if rawPorts, ok := cm["ports"].([]interface{}); ok {
					for _, p := range rawPorts {
						pm, _ := p.(map[string]interface{})
						if pm == nil {
							continue
						}
						port := map[string]interface{}{}
						if cp, ok := toInt64(pm["containerPort"]); ok {
							port["container_port"] = cp
						}
						if proto, ok := pm["protocol"].(string); ok {
							port["protocol"] = proto
						}
						if pn, ok := pm["name"].(string); ok {
							port["name"] = pn
						}
						ports = append(ports, port)
					}
				}
				container["ports"] = ports

				// resources
				resources := map[string]interface{}{}
				if rawRes, ok := cm["resources"].(map[string]interface{}); ok {
					if req, ok := rawRes["requests"].(map[string]interface{}); ok {
						r := map[string]string{}
						for k, v := range req {
							if vs, ok := v.(string); ok {
								r[k] = vs
							}
						}
						resources["requests"] = r
					}
					if lim, ok := rawRes["limits"].(map[string]interface{}); ok {
						l := map[string]string{}
						for k, v := range lim {
							if vs, ok := v.(string); ok {
								l[k] = vs
							}
						}
						resources["limits"] = l
					}
				}
				container["resources"] = resources

				// volume_mounts
				volumeMounts := []map[string]interface{}{}
				if rawVM, ok := cm["volumeMounts"].([]interface{}); ok {
					for _, vm := range rawVM {
						vmm, _ := vm.(map[string]interface{})
						if vmm == nil {
							continue
						}
						vmEntry := map[string]interface{}{}
						if n, ok := vmm["name"].(string); ok {
							vmEntry["name"] = n
						}
						if mp, ok := vmm["mountPath"].(string); ok {
							vmEntry["mount_path"] = mp
						}
						if ro, ok := vmm["readOnly"].(bool); ok {
							vmEntry["read_only"] = ro
						} else {
							vmEntry["read_only"] = false
						}
						volumeMounts = append(volumeMounts, vmEntry)
					}
				}
				container["volume_mounts"] = volumeMounts

				// env_count
				envCount := 0
				if rawEnv, ok := cm["env"].([]interface{}); ok {
					envCount = len(rawEnv)
				}
				container["env_count"] = envCount

				// command/args
				if rawCmd, ok := cm["command"].([]interface{}); ok && len(rawCmd) > 0 {
					container["command"] = rawCmd
				}
				if rawArgs, ok := cm["args"].([]interface{}); ok && len(rawArgs) > 0 {
					container["args"] = rawArgs
				}

				if cs := containerStatuses[name]; cs != nil {
					if ready, ok := cs["ready"].(bool); ok {
						container["ready"] = ready
						if ready {
							totalReady++
						}
					}
					if rc, ok := toInt64(cs["restartCount"]); ok {
						container["restart_count"] = rc
						totalRestarts += rc
					}
					container["state"] = containerStateStrFromMap(cs["state"])
					container["last_state"] = containerStateStrFromMap(cs["lastState"])
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
				if cs := initContainerStatuses[name]; cs != nil {
					if ready, ok := cs["ready"].(bool); ok {
						ic["ready"] = ready
					}
					if rc, ok := toInt64(cs["restartCount"]); ok {
						ic["restart_count"] = rc
					}
					ic["state"] = containerStateStrFromMap(cs["state"])
				}
				initContainers = append(initContainers, ic)
			}
		}
	}

	// status / reason / message — formatPodDetail 와 동일 logic
	statusStr := phase
	reason := ""
	message := ""
	if status != nil {
		reason, _ = status["reason"].(string)
		message, _ = status["message"].(string)
	}
	for _, cs := range containerStatuses {
		state, _ := cs["state"].(map[string]interface{})
		if state == nil {
			continue
		}
		if waiting, ok := state["waiting"].(map[string]interface{}); ok {
			if r, _ := waiting["reason"].(string); r != "" {
				statusStr = r
				if reason == "" {
					reason = r
				}
				if message == "" {
					if m, _ := waiting["message"].(string); m != "" {
						message = m
					}
				}
				break
			}
		}
		if terminated, ok := state["terminated"].(map[string]interface{}); ok {
			if r, _ := terminated["reason"].(string); r != "" {
				if phase != "Running" {
					statusStr = r
				}
				break
			}
		}
	}

	out := map[string]interface{}{
		"name":            metadata["name"],
		"namespace":       metadata["namespace"],
		"status":          statusStr,
		"phase":           phase,
		"reason":          reason,
		"status_reason":   reason,
		"message":         message,
		"status_message":  message,
		"node_name":       nodeName,
		"pod_ip":          podIP,
		"containers":      containers,
		"init_containers": initContainers,
		"labels":          metadata["labels"],
		"restart_count":   totalRestarts,
		"ready":           fmt.Sprintf("%d/%d", totalReady, totalContainers),
		"created_at":      metadata["creationTimestamp"],
	}
	if dt, ok := metadata["deletionTimestamp"].(string); ok && dt != "" {
		out["deletion_timestamp"] = dt
	}

	// owner_references — pods_format.formatPodDetail 과 동일 shape. ownerRef
	// 매칭에 필수 (WorkloadOwnedResources / RB Bound Pods 등).
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

	// service_account_name — SA reverse lookup (ServiceAccountInfo Pods Using).
	if sa, _ := spec["serviceAccountName"].(string); sa != "" {
		out["service_account_name"] = sa
	}

	// priority_class_name / runtime_class_name — 5.7.
	if pc, _ := spec["priorityClassName"].(string); pc != "" {
		out["priority_class_name"] = pc
	}
	if rc, _ := spec["runtimeClassName"].(string); rc != "" {
		out["runtime_class_name"] = rc
	}

	// config_map_refs / secret_refs — 5.4 ConfigMap/Secret Used By Pods reverse
	// lookup. backend pods_format.formatPodDetail 과 동일한 추출 로직 (volumes /
	// projected / envFrom / env.valueFrom / imagePullSecrets).
	cms := map[string]struct{}{}
	secrets := map[string]struct{}{}
	if vols, ok := spec["volumes"].([]interface{}); ok {
		for _, v := range vols {
			vm, _ := v.(map[string]interface{})
			if vm == nil {
				continue
			}
			if cm, _ := vm["configMap"].(map[string]interface{}); cm != nil {
				if n, _ := cm["name"].(string); n != "" {
					cms[n] = struct{}{}
				}
			}
			if sec, _ := vm["secret"].(map[string]interface{}); sec != nil {
				if n, _ := sec["secretName"].(string); n != "" {
					secrets[n] = struct{}{}
				}
			}
			if proj, _ := vm["projected"].(map[string]interface{}); proj != nil {
				if srcs, _ := proj["sources"].([]interface{}); ok {
					for _, s := range srcs {
						sm, _ := s.(map[string]interface{})
						if sm == nil {
							continue
						}
						if cm, _ := sm["configMap"].(map[string]interface{}); cm != nil {
							if n, _ := cm["name"].(string); n != "" {
								cms[n] = struct{}{}
							}
						}
						if sec, _ := sm["secret"].(map[string]interface{}); sec != nil {
							if n, _ := sec["name"].(string); n != "" {
								secrets[n] = struct{}{}
							}
						}
					}
				}
			}
		}
	}
	collectEnvRefs := func(containers []interface{}) {
		for _, c := range containers {
			cm, _ := c.(map[string]interface{})
			if cm == nil {
				continue
			}
			if envFrom, ok := cm["envFrom"].([]interface{}); ok {
				for _, e := range envFrom {
					em, _ := e.(map[string]interface{})
					if em == nil {
						continue
					}
					if r, _ := em["configMapRef"].(map[string]interface{}); r != nil {
						if n, _ := r["name"].(string); n != "" {
							cms[n] = struct{}{}
						}
					}
					if r, _ := em["secretRef"].(map[string]interface{}); r != nil {
						if n, _ := r["name"].(string); n != "" {
							secrets[n] = struct{}{}
						}
					}
				}
			}
			if envs, ok := cm["env"].([]interface{}); ok {
				for _, e := range envs {
					em, _ := e.(map[string]interface{})
					if em == nil {
						continue
					}
					vf, _ := em["valueFrom"].(map[string]interface{})
					if vf == nil {
						continue
					}
					if r, _ := vf["configMapKeyRef"].(map[string]interface{}); r != nil {
						if n, _ := r["name"].(string); n != "" {
							cms[n] = struct{}{}
						}
					}
					if r, _ := vf["secretKeyRef"].(map[string]interface{}); r != nil {
						if n, _ := r["name"].(string); n != "" {
							secrets[n] = struct{}{}
						}
					}
				}
			}
		}
	}
	if cs, ok := spec["containers"].([]interface{}); ok {
		collectEnvRefs(cs)
	}
	if ics, ok := spec["initContainers"].([]interface{}); ok {
		collectEnvRefs(ics)
	}
	if ips, ok := spec["imagePullSecrets"].([]interface{}); ok {
		for _, s := range ips {
			sm, _ := s.(map[string]interface{})
			if sm == nil {
				continue
			}
			if n, _ := sm["name"].(string); n != "" {
				secrets[n] = struct{}{}
			}
		}
	}
	if len(cms) > 0 {
		list := make([]string, 0, len(cms))
		for k := range cms {
			list = append(list, k)
		}
		out["config_map_refs"] = list
	}
	if len(secrets) > 0 {
		list := make([]string, 0, len(secrets))
		for k := range secrets {
			list = append(list, k)
		}
		out["secret_refs"] = list
	}

	// DRA resource claims — 5.6 #20.
	if rcs, ok := spec["resourceClaims"].([]interface{}); ok && len(rcs) > 0 {
		claimNames := make([]string, 0)
		templateNames := make([]string, 0)
		for _, rc := range rcs {
			rm, _ := rc.(map[string]interface{})
			if rm == nil {
				continue
			}
			src, _ := rm["source"].(map[string]interface{})
			if src == nil {
				continue
			}
			if n, _ := src["resourceClaimName"].(string); n != "" {
				claimNames = append(claimNames, n)
			}
			if n, _ := src["resourceClaimTemplateName"].(string); n != "" {
				templateNames = append(templateNames, n)
			}
		}
		if len(claimNames) > 0 {
			out["resource_claims"] = claimNames
		}
		if len(templateNames) > 0 {
			out["resource_claim_templates"] = templateNames
		}
	}

	return out
}

// nodeToInfo — list endpoint: formatNodeSummary (nodes.go).
func nodeToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	nodeStatus := "Unknown"
	if status != nil {
		if conditions, ok := status["conditions"].([]interface{}); ok {
			for _, c := range conditions {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				if cm["type"] == "Ready" {
					if cm["status"] == "True" {
						nodeStatus = "Ready"
					} else {
						nodeStatus = "NotReady"
					}
					break
				}
			}
		}
	}

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
				if am == nil {
					continue
				}
				if am["type"] == "InternalIP" && internalIP == "" {
					internalIP, _ = am["address"].(string)
				} else if am["type"] == "ExternalIP" && externalIP == "" {
					externalIP, _ = am["address"].(string)
				}
			}
		}
	}

	taints := []map[string]interface{}{}
	if spec != nil {
		if taintsList, ok := spec["taints"].([]interface{}); ok {
			for _, t := range taintsList {
				tm, _ := t.(map[string]interface{})
				if tm != nil {
					value := ""
					if v, ok := tm["value"].(string); ok {
						value = v
					}
					taints = append(taints, map[string]interface{}{
						"key":    tm["key"],
						"value":  value,
						"effect": tm["effect"],
					})
				}
			}
		}
	}

	var osImage, kernelVersion, containerRuntime, kubeletVersion string
	if status != nil {
		if nodeInfo, ok := status["nodeInfo"].(map[string]interface{}); ok {
			osImage, _ = nodeInfo["osImage"].(string)
			kernelVersion, _ = nodeInfo["kernelVersion"].(string)
			containerRuntime, _ = nodeInfo["containerRuntimeVersion"].(string)
			kubeletVersion, _ = nodeInfo["kubeletVersion"].(string)
		}
	}

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

	// capacity / allocatable — value 를 string 으로 변환 (formatNodeSummary 동일)
	capacity := map[string]string{}
	allocatable := map[string]string{}
	if status != nil {
		if c, ok := status["capacity"].(map[string]interface{}); ok {
			for k, v := range c {
				if vs, ok := v.(string); ok {
					capacity[k] = vs
				}
			}
		}
		if a, ok := status["allocatable"].(map[string]interface{}); ok {
			for k, v := range a {
				if vs, ok := v.(string); ok {
					allocatable[k] = vs
				}
			}
		}
	}

	// age 계산 (formatNodeSummary 의 age() 와 동일)
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
		"internal_ip":       internalIP,
		"external_ip":       externalIP,
		"version":           kubeletVersion,
		"os_image":          osImage,
		"kernel_version":    kernelVersion,
		"container_runtime": containerRuntime,
		"kubelet_version":   kubeletVersion,
		"age":               ageStr,
		"created_at":        metadata["creationTimestamp"],
		"labels":            metadata["labels"],
		"taints":            taints,
		"conditions":        conditions,
		"capacity":          capacity,
		"allocatable":       allocatable,
	}
}

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

// deploymentToInfo — list endpoint: formatDeploymentDetail (deployments.go).
func deploymentToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var replicas, readyReplicas, availableReplicas, updatedReplicas int64
	if spec != nil {
		replicas, _ = toInt64(spec["replicas"])
	}
	if status != nil {
		readyReplicas, _ = toInt64(status["readyReplicas"])
		availableReplicas, _ = toInt64(status["availableReplicas"])
		updatedReplicas, _ = toInt64(status["updatedReplicas"])
	}

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	// status — formatDeploymentDetail 과 동일 logic (Available/Failed/Progressing)
	depStatus := "Progressing"
	if status != nil {
		if conds, ok := status["conditions"].([]interface{}); ok {
			for _, c := range conds {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				ctype, _ := cm["type"].(string)
				cstatus, _ := cm["status"].(string)
				if ctype == "Available" && cstatus == "True" {
					depStatus = "Available"
					break
				}
				if ctype == "Progressing" && cstatus == "False" {
					depStatus = "Failed"
					break
				}
			}
		}
	}

	selector := selectorMatchLabels(spec)

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"replicas":           replicas,
		"ready_replicas":     readyReplicas,
		"available_replicas": availableReplicas,
		"updated_replicas":   updatedReplicas,
		"image":              image,
		"images":             images,
		"labels":             metadata["labels"],
		"selector":           selector,
		"status":             depStatus,
		"created_at":         metadata["creationTimestamp"],
	}
}

// pvcToInfo — list endpoint: formatPVCDetail (storage_pvc.go).
func pvcToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	phase := ""
	if status != nil {
		if p, ok := status["phase"].(string); ok {
			phase = p
		}
	}

	capacity := ""
	if status != nil {
		if cap, ok := status["capacity"].(map[string]interface{}); ok {
			if s, ok := cap["storage"].(string); ok {
				capacity = s
			}
		}
	}

	requested := ""
	if spec != nil {
		if res, ok := spec["resources"].(map[string]interface{}); ok {
			if req, ok := res["requests"].(map[string]interface{}); ok {
				if s, ok := req["storage"].(string); ok {
					requested = s
				}
			}
		}
	}

	accessModes := []string{}
	if spec != nil {
		if am, ok := spec["accessModes"].([]interface{}); ok {
			for _, m := range am {
				if s, ok := m.(string); ok {
					accessModes = append(accessModes, s)
				}
			}
		}
	}

	storageClass := ""
	if spec != nil {
		if sc, ok := spec["storageClassName"].(string); ok {
			storageClass = sc
		}
	}

	volumeName := ""
	if spec != nil {
		if vn, ok := spec["volumeName"].(string); ok {
			volumeName = vn
		}
	}

	return map[string]interface{}{
		"name":          metadata["name"],
		"namespace":     metadata["namespace"],
		"status":        phase,
		"volume_name":   volumeName,
		"capacity":      capacity,
		"requested":     requested,
		"access_modes":  accessModes,
		"storage_class": storageClass,
		"created_at":    metadata["creationTimestamp"],
	}
}

// pvToInfo — list endpoint: formatPVDetail (storage_pv.go).
func pvToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	phase := ""
	reason := ""
	if status != nil {
		if p, ok := status["phase"].(string); ok {
			phase = p
		}
		if r, ok := status["reason"].(string); ok {
			reason = r
		}
	}

	capacity := ""
	if spec != nil {
		if cap, ok := spec["capacity"].(map[string]interface{}); ok {
			if s, ok := cap["storage"].(string); ok {
				capacity = s
			}
		}
	}

	accessModes := []string{}
	if spec != nil {
		if am, ok := spec["accessModes"].([]interface{}); ok {
			for _, m := range am {
				if s, ok := m.(string); ok {
					accessModes = append(accessModes, s)
				}
			}
		}
	}

	reclaimPolicy := ""
	if spec != nil {
		if rp, ok := spec["persistentVolumeReclaimPolicy"].(string); ok {
			reclaimPolicy = rp
		}
	}

	storageClass := ""
	if spec != nil {
		if sc, ok := spec["storageClassName"].(string); ok {
			storageClass = sc
		}
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

	volumeMode := ""
	if spec != nil {
		if vm, ok := spec["volumeMode"].(string); ok {
			volumeMode = vm
		}
	}

	// source / driver / volume_handle — formatPVDetail 과 동일 분기
	source := ""
	driver := ""
	volumeHandle := ""
	if spec != nil {
		if csi, ok := spec["csi"].(map[string]interface{}); ok {
			source = "CSI"
			if d, ok := csi["driver"].(string); ok {
				driver = d
			}
			if vh, ok := csi["volumeHandle"].(string); ok {
				volumeHandle = vh
			}
		} else if nfs, ok := spec["nfs"].(map[string]interface{}); ok {
			source = "NFS"
			server, _ := nfs["server"].(string)
			path, _ := nfs["path"].(string)
			driver = fmt.Sprintf("%s:%s", server, path)
		} else if local, ok := spec["local"].(map[string]interface{}); ok {
			source = "Local"
			driver, _ = local["path"].(string)
		} else if hp, ok := spec["hostPath"].(map[string]interface{}); ok {
			source = "HostPath"
			driver, _ = hp["path"].(string)
		}
	}

	return map[string]interface{}{
		"name":           metadata["name"],
		"status":         phase,
		"capacity":       capacity,
		"access_modes":   accessModes,
		"reclaim_policy": reclaimPolicy,
		"storage_class":  storageClass,
		"claim_ref":      claimRef,
		"volume_mode":    volumeMode,
		"source":         source,
		"driver":         driver,
		"volume_handle":  volumeHandle,
		"reason":         reason,
		"created_at":     metadata["creationTimestamp"],
	}
}

// storageclassToInfo — list endpoint: formatStorageClassDetail (storage_class.go).
func storageclassToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})

	provisioner := ""
	if p, ok := obj.Object["provisioner"].(string); ok {
		provisioner = p
	}
	reclaimPolicy := ""
	if rp, ok := obj.Object["reclaimPolicy"].(string); ok {
		reclaimPolicy = rp
	}
	volumeBindingMode := ""
	if vb, ok := obj.Object["volumeBindingMode"].(string); ok {
		volumeBindingMode = vb
	}
	allowExpansion := false
	if a, ok := obj.Object["allowVolumeExpansion"].(bool); ok {
		allowExpansion = a
	}

	annotations, _ := metadata["annotations"].(map[string]interface{})
	isDefault := false
	if annotations != nil {
		if v, ok := annotations["storageclass.kubernetes.io/is-default-class"].(string); ok && v == "true" {
			isDefault = true
		}
	}

	parameters, _ := obj.Object["parameters"].(map[string]interface{})

	mountOptions := []string{}
	if mo, ok := obj.Object["mountOptions"].([]interface{}); ok {
		for _, m := range mo {
			if s, ok := m.(string); ok {
				mountOptions = append(mountOptions, s)
			}
		}
	}

	return map[string]interface{}{
		"name":                   metadata["name"],
		"provisioner":            provisioner,
		"reclaim_policy":         reclaimPolicy,
		"volume_binding_mode":    volumeBindingMode,
		"allow_volume_expansion": allowExpansion,
		"is_default":             isDefault,
		"parameters":             parameters,
		"mount_options":          mountOptions,
		"labels":                 metadata["labels"],
		"annotations":            metadata["annotations"],
		"created_at":             metadata["creationTimestamp"],
	}
}

// statefulsetToInfo — list endpoint: formatStatefulSetDetail (workloads_formatters.go).
func statefulsetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var replicas, readyReplicas, currentReplicas, updatedReplicas, availableReplicas int64
	if spec != nil {
		replicas, _ = toInt64(spec["replicas"])
	}
	if status != nil {
		readyReplicas, _ = toInt64(status["readyReplicas"])
		currentReplicas, _ = toInt64(status["currentReplicas"])
		updatedReplicas, _ = toInt64(status["updatedReplicas"])
		availableReplicas, _ = toInt64(status["availableReplicas"])
	}

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	selector := selectorMatchLabels(spec)

	serviceName := ""
	if spec != nil {
		if sn, ok := spec["serviceName"].(string); ok {
			serviceName = sn
		}
	}

	// status — formatStatefulSetDetail 과 동일 logic
	stsStatus := "Healthy"
	if replicas == 0 {
		stsStatus = "Idle"
	} else if readyReplicas < replicas {
		stsStatus = "Degraded"
	} else if availableReplicas == 0 && replicas > 0 {
		stsStatus = "Unavailable"
	}

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"replicas":           replicas,
		"ready_replicas":     readyReplicas,
		"current_replicas":   currentReplicas,
		"updated_replicas":   updatedReplicas,
		"available_replicas": availableReplicas,
		"image":              image,
		"images":             images,
		"selector":           selector,
		"service_name":       serviceName,
		"status":             stsStatus,
		"created_at":         metadata["creationTimestamp"],
	}
}

// daemonsetToInfo — list endpoint: formatDaemonSetDetail (workloads_formatters.go).
func daemonsetToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	var desired, current, ready, available, misscheduled, updated, unavailable int64
	if status != nil {
		desired, _ = toInt64(status["desiredNumberScheduled"])
		current, _ = toInt64(status["currentNumberScheduled"])
		ready, _ = toInt64(status["numberReady"])
		available, _ = toInt64(status["numberAvailable"])
		misscheduled, _ = toInt64(status["numberMisscheduled"])
		updated, _ = toInt64(status["updatedNumberScheduled"])
		unavailable, _ = toInt64(status["numberUnavailable"])
	}

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	selector := selectorMatchLabels(spec)

	// node_selector 는 spec.template.spec.nodeSelector
	var nodeSelector interface{}
	if spec != nil {
		if tmpl, ok := spec["template"].(map[string]interface{}); ok {
			if podSpec, ok := tmpl["spec"].(map[string]interface{}); ok {
				nodeSelector = podSpec["nodeSelector"]
			}
		}
	}

	dsStatus := "Healthy"
	if desired == 0 {
		dsStatus = "Idle"
	} else if ready < desired {
		dsStatus = "Degraded"
	} else if available == 0 && desired > 0 {
		dsStatus = "Unavailable"
	}

	return map[string]interface{}{
		"name":          metadata["name"],
		"namespace":     metadata["namespace"],
		"desired":       desired,
		"current":       current,
		"ready":         ready,
		"updated":       updated,
		"available":     available,
		"misscheduled":  misscheduled,
		"unavailable":   unavailable,
		"node_selector": nodeSelector,
		"image":         image,
		"images":        images,
		"selector":      selector,
		"status":        dsStatus,
		"created_at":    metadata["creationTimestamp"],
	}
}

// replicasetToInfo — list endpoint: formatReplicaSetDetail (workloads_formatters.go).
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

	images := containerImages(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	selector := selectorMatchLabels(spec)

	// owner_deployment — ownerReferences 에서 Kind=="Deployment" 의 Name. owner_references 전체도
	// 함께 노출 (5.2 Deployment Owned RS / WorkloadOwnedResources 의 ownerRef filter 가
	// watch event 에서 정확히 매칭하도록).
	owner := ""
	var ownerRefs []map[string]interface{}
	if ors, ok := metadata["ownerReferences"].([]interface{}); ok && len(ors) > 0 {
		ownerRefs = make([]map[string]interface{}, 0, len(ors))
		for _, o := range ors {
			om, _ := o.(map[string]interface{})
			if om == nil {
				continue
			}
			ctrl, _ := om["controller"].(bool)
			ownerRefs = append(ownerRefs, map[string]interface{}{
				"kind":       om["kind"],
				"name":       om["name"],
				"uid":        om["uid"],
				"controller": ctrl,
			})
			if k, _ := om["kind"].(string); k == "Deployment" && owner == "" {
				if n, _ := om["name"].(string); n != "" {
					owner = n
				}
			}
		}
	}

	rsStatus := "Healthy"
	if replicas == 0 {
		rsStatus = "Idle"
	} else if readyReplicas < replicas {
		rsStatus = "Degraded"
	} else if availableReplicas == 0 && replicas > 0 {
		rsStatus = "Unavailable"
	}

	out := map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"replicas":           replicas,
		"ready_replicas":     readyReplicas,
		"available_replicas": availableReplicas,
		"image":              image,
		"images":             images,
		"selector":           selector,
		"owner_deployment":   owner,
		"status":             rsStatus,
		"created_at":         metadata["creationTimestamp"],
	}
	if len(ownerRefs) > 0 {
		out["owner_references"] = ownerRefs
	}
	return out
}

// jobToInfo — list endpoint: formatJobDetail (workloads_formatters.go).
func jobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	completions := int64(1)
	parallelism := int64(1)
	if spec != nil {
		if c, ok := toInt64(spec["completions"]); ok {
			completions = c
		}
		if p, ok := toInt64(spec["parallelism"]); ok {
			parallelism = p
		}
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

	// status — formatJobDetail 과 동일 logic
	jobStatus := "Running"
	if status != nil {
		if conds, ok := status["conditions"].([]interface{}); ok {
			for _, c := range conds {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				ctype, _ := cm["type"].(string)
				cstatus, _ := cm["status"].(string)
				if ctype == "Complete" && cstatus == "True" {
					jobStatus = "Complete"
					break
				}
				if ctype == "Failed" && cstatus == "True" {
					jobStatus = "Failed"
					break
				}
			}
		}
	}

	images := containerImagesFromTemplate(spec)
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	// owner_references — CronJob owned Jobs 매칭에 필수 (5.6 #12).
	var ownerRefs []map[string]interface{}
	if ors, ok := metadata["ownerReferences"].([]interface{}); ok && len(ors) > 0 {
		ownerRefs = make([]map[string]interface{}, 0, len(ors))
		for _, r := range ors {
			rm, _ := r.(map[string]interface{})
			if rm == nil {
				continue
			}
			ctrl, _ := rm["controller"].(bool)
			ownerRefs = append(ownerRefs, map[string]interface{}{
				"kind":       rm["kind"],
				"name":       rm["name"],
				"uid":        rm["uid"],
				"controller": ctrl,
			})
		}
	}

	out := map[string]interface{}{
		"name":        metadata["name"],
		"namespace":   metadata["namespace"],
		"completions": completions,
		"parallelism": parallelism,
		"succeeded":   succeeded,
		"failed":      failed,
		"active":      active,
		"status":      jobStatus,
		"image":       image,
		"images":      images,
		"created_at":  metadata["creationTimestamp"],
	}
	if len(ownerRefs) > 0 {
		out["owner_references"] = ownerRefs
	}

	if st, ok := startTime.(string); ok && st != "" {
		out["start_time"] = st
	}
	if ct, ok := completionTime.(string); ok && ct != "" {
		out["completion_time"] = ct
	}
	if st, ok := startTime.(string); ok && st != "" {
		if ct, ok := completionTime.(string); ok && ct != "" {
			stTime, err1 := time.Parse(time.RFC3339, st)
			ctTime, err2 := time.Parse(time.RFC3339, ct)
			if err1 == nil && err2 == nil {
				// formatJobDetail 은 duration 을 time.Duration.String() 로 직렬화
				out["duration"] = ctTime.Sub(stTime).String()
			}
		}
	}

	return out
}

// cronjobToInfo — list endpoint: formatCronJobDetail (workloads_formatters.go).
func cronjobToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	schedule := ""
	suspend := false
	concurrencyPolicy := ""
	if spec != nil {
		if s, ok := spec["schedule"].(string); ok {
			schedule = s
		}
		if s, ok := spec["suspend"].(bool); ok {
			suspend = s
		}
		if cp, ok := spec["concurrencyPolicy"].(string); ok {
			concurrencyPolicy = cp
		}
	}

	activeCount := 0
	var lastScheduleTime, lastSuccessfulTime interface{}
	if status != nil {
		if activeList, ok := status["active"].([]interface{}); ok {
			activeCount = len(activeList)
		}
		lastScheduleTime = status["lastScheduleTime"]
		lastSuccessfulTime = status["lastSuccessfulTime"]
	}

	// images — spec.jobTemplate.spec.template.spec.containers
	images := []string{}
	if spec != nil {
		if jt, ok := spec["jobTemplate"].(map[string]interface{}); ok {
			if jtSpec, ok := jt["spec"].(map[string]interface{}); ok {
				images = containerImagesFromTemplate(jtSpec)
			}
		}
	}
	image := ""
	if len(images) > 0 {
		image = images[0]
	}

	out := map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"schedule":           schedule,
		"suspend":            suspend,
		"active":             activeCount,
		"image":              image,
		"images":             images,
		"concurrency_policy": concurrencyPolicy,
		"created_at":         metadata["creationTimestamp"],
	}
	if ls, ok := lastScheduleTime.(string); ok && ls != "" {
		out["last_schedule"] = ls
	}
	if lsu, ok := lastSuccessfulTime.(string); ok && lsu != "" {
		out["last_successful"] = lsu
	}

	return out
}

// ingressToInfo — list endpoint: formatIngressDetail (networking.go).
func ingressToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	hosts := []string{}
	backendSet := map[string]bool{}
	backends := []string{}

	rules := []map[string]interface{}{}
	if spec != nil {
		if rawRules, ok := spec["rules"].([]interface{}); ok {
			for _, r := range rawRules {
				rm, _ := r.(map[string]interface{})
				if rm == nil {
					continue
				}
				host, _ := rm["host"].(string)
				if host != "" {
					hosts = append(hosts, host)
				}
				ruleEntry := map[string]interface{}{
					"host": host,
				}
				if http, ok := rm["http"].(map[string]interface{}); ok {
					paths := []map[string]interface{}{}
					if rawPaths, ok := http["paths"].([]interface{}); ok {
						for _, p := range rawPaths {
							pm, _ := p.(map[string]interface{})
							if pm == nil {
								continue
							}
							pathEntry := map[string]interface{}{
								"path": pm["path"],
							}
							if pt, ok := pm["pathType"].(string); ok {
								pathEntry["path_type"] = pt
							}
							if backend, ok := pm["backend"].(map[string]interface{}); ok {
								if svc, ok := backend["service"].(map[string]interface{}); ok {
									svcName, _ := svc["name"].(string)
									backendEntry := map[string]interface{}{
										"service_name": svcName,
									}
									if portMap, ok := svc["port"].(map[string]interface{}); ok {
										if pn, ok := toInt64(portMap["number"]); ok && pn > 0 {
											backendEntry["service_port"] = pn
										}
										if pname, ok := portMap["name"].(string); ok && pname != "" {
											backendEntry["service_port_name"] = pname
										}
									}
									pathEntry["backend"] = backendEntry
									if !backendSet[svcName] {
										backendSet[svcName] = true
										backends = append(backends, svcName)
									}
								}
							}
							paths = append(paths, pathEntry)
						}
					}
					ruleEntry["paths"] = paths
				}
				rules = append(rules, ruleEntry)
			}
		}
	}
	// formatIngressDetail 은 backends 정렬
	sortStrings(backends)

	addresses := []map[string]interface{}{}
	if status != nil {
		if lb, ok := status["loadBalancer"].(map[string]interface{}); ok {
			if rawIng, ok := lb["ingress"].([]interface{}); ok {
				for _, ing := range rawIng {
					ingm, _ := ing.(map[string]interface{})
					if ingm == nil {
						continue
					}
					addr := map[string]interface{}{}
					if ip, ok := ingm["ip"].(string); ok && ip != "" {
						addr["ip"] = ip
					}
					if hn, ok := ingm["hostname"].(string); ok && hn != "" {
						addr["hostname"] = hn
					}
					addresses = append(addresses, addr)
				}
			}
		}
	}

	// class / class_source — spec.ingressClassName 우선, 없으면 annotation
	ingressClass := ""
	classSource := ""
	annotations, _ := metadata["annotations"].(map[string]interface{})
	if spec != nil {
		if icn, ok := spec["ingressClassName"].(string); ok && icn != "" {
			ingressClass = icn
			classSource = "spec"
		}
	}
	if ingressClass == "" && annotations != nil {
		if v, ok := annotations["kubernetes.io/ingress.class"].(string); ok && v != "" {
			ingressClass = v
			classSource = "annotation"
		}
	}

	tls := []map[string]interface{}{}
	if spec != nil {
		if rawTLS, ok := spec["tls"].([]interface{}); ok {
			for _, t := range rawTLS {
				tm, _ := t.(map[string]interface{})
				if tm == nil {
					continue
				}
				secretName, _ := tm["secretName"].(string)
				tlsHosts := []string{}
				if rh, ok := tm["hosts"].([]interface{}); ok {
					for _, h := range rh {
						if s, ok := h.(string); ok {
							tlsHosts = append(tlsHosts, s)
						}
					}
				}
				tls = append(tls, map[string]interface{}{
					"secret_name": secretName,
					"hosts":       tlsHosts,
				})
			}
		}
	}

	var defaultBackend interface{}
	if spec != nil {
		if db, ok := spec["defaultBackend"].(map[string]interface{}); ok {
			if svc, ok := db["service"].(map[string]interface{}); ok {
				dbEntry := map[string]interface{}{
					"type":         "service",
					"service_name": svc["name"],
				}
				if port, ok := svc["port"].(map[string]interface{}); ok {
					if pn, ok := toInt64(port["number"]); ok && pn > 0 {
						dbEntry["service_port"] = pn
					}
				}
				defaultBackend = dbEntry
			}
		}
	}

	return map[string]interface{}{
		"name":            metadata["name"],
		"namespace":       metadata["namespace"],
		"class":           ingressClass,
		"class_source":    classSource,
		"hosts":           hosts,
		"addresses":       addresses,
		"tls":             tls,
		"default_backend": defaultBackend,
		"rules":           rules,
		"backends":        backends,
		"labels":          metadata["labels"],
		"annotations":     metadata["annotations"],
		"created_at":      metadata["creationTimestamp"],
	}
}

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

// hpaToInfo — list endpoint: formatHPADetail (hpa.go).
func hpaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	targetRef := ""
	targetRefKind := ""
	targetRefName := ""
	if spec != nil {
		if ref, ok := spec["scaleTargetRef"].(map[string]interface{}); ok {
			targetRefKind, _ = ref["kind"].(string)
			targetRefName, _ = ref["name"].(string)
			targetRef = targetRefKind + "/" + targetRefName
		}
	}

	var maxReplicas int64
	var minReplicas interface{}
	if spec != nil {
		maxReplicas, _ = toInt64(spec["maxReplicas"])
		if mr, ok := toInt64(spec["minReplicas"]); ok {
			minReplicas = mr
		}
	}

	var currentReplicas, desiredReplicas int64
	var lastScaleTime interface{}
	if status != nil {
		currentReplicas, _ = toInt64(status["currentReplicas"])
		desiredReplicas, _ = toInt64(status["desiredReplicas"])
		lastScaleTime = status["lastScaleTime"]
	}

	// metrics — spec.metrics 와 status.currentMetrics 의 simplified merge.
	// formatHPADetail 의 formatMetricSpec/formatMetricStatus 는 길이가 크기 때문에
	// list 와 watch 가 동일 keys 만 갖도록 raw map 자체를 통과 (frontend 가 동일
	// raw 형태도 처리). 빠진 추가 derived 필드는 다음 reconcile (재 fetch) 에서
	// 채워진다.
	metrics := []map[string]interface{}{}
	if spec != nil {
		if rawMetrics, ok := spec["metrics"].([]interface{}); ok {
			for i, m := range rawMetrics {
				mm, _ := m.(map[string]interface{})
				if mm == nil {
					continue
				}
				entry := hpaMetricSpecToMap(mm)
				if status != nil {
					if curr, ok := status["currentMetrics"].([]interface{}); ok && i < len(curr) {
						if cm, ok := curr[i].(map[string]interface{}); ok {
							entry["current"] = hpaMetricStatusToMap(cm)
						}
					}
				}
				metrics = append(metrics, entry)
			}
		}
	}

	out := map[string]interface{}{
		"name":             metadata["name"],
		"namespace":        metadata["namespace"],
		"target_ref":       targetRef,
		"target_ref_kind":  targetRefKind,
		"target_ref_name":  targetRefName,
		"max_replicas":     maxReplicas,
		"current_replicas": currentReplicas,
		"desired_replicas": desiredReplicas,
		"metrics":          metrics,
		"labels":           metadata["labels"],
		"created_at":       metadata["creationTimestamp"],
	}
	if minReplicas != nil {
		out["min_replicas"] = minReplicas
	}
	if ls, ok := lastScaleTime.(string); ok && ls != "" {
		out["last_scale_time"] = ls
	}
	return out
}

// vpaToInfo — list endpoint: formatVPADetailFromUnstructured (vpa.go).
func vpaToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata := obj.Object["metadata"].(map[string]interface{})
	spec, _ := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	targetRef := ""
	targetRefKind := ""
	targetRefName := ""
	if spec != nil {
		if ref, ok := spec["targetRef"].(map[string]interface{}); ok {
			targetRefKind, _ = ref["kind"].(string)
			targetRefName, _ = ref["name"].(string)
			targetRef = fmt.Sprintf("%s/%s", targetRefKind, targetRefName)
		}
	}

	updateMode := ""
	if spec != nil {
		if up, ok := spec["updatePolicy"].(map[string]interface{}); ok {
			updateMode, _ = up["updateMode"].(string)
		}
	}

	// container_policies
	var containerPolicies []map[string]interface{}
	if spec != nil {
		if rp, ok := spec["resourcePolicy"].(map[string]interface{}); ok {
			if cps, ok := rp["containerPolicies"].([]interface{}); ok && len(cps) > 0 {
				containerPolicies = make([]map[string]interface{}, 0, len(cps))
				for _, p := range cps {
					pm, _ := p.(map[string]interface{})
					if pm == nil {
						continue
					}
					cp := map[string]interface{}{
						"container_name": strOrEmpty(pm["containerName"]),
						"mode":           strOrEmpty(pm["mode"]),
					}
					if cr, ok := pm["controlledResources"].([]interface{}); ok && len(cr) > 0 {
						crs := []string{}
						for _, c := range cr {
							if s, ok := c.(string); ok {
								crs = append(crs, s)
							}
						}
						if len(crs) > 0 {
							cp["controlled_resources"] = crs
						}
					}
					if cv, _ := pm["controlledValues"].(string); cv != "" {
						cp["controlled_values"] = cv
					}
					if minA, ok := pm["minAllowed"].(map[string]interface{}); ok {
						cp["min_allowed"] = minA
					}
					if maxA, ok := pm["maxAllowed"].(map[string]interface{}); ok {
						cp["max_allowed"] = maxA
					}
					containerPolicies = append(containerPolicies, cp)
				}
			}
		}
	}

	// conditions
	var conditions []map[string]interface{}
	if status != nil {
		if conds, ok := status["conditions"].([]interface{}); ok && len(conds) > 0 {
			conditions = make([]map[string]interface{}, 0, len(conds))
			for _, c := range conds {
				cm, _ := c.(map[string]interface{})
				if cm == nil {
					continue
				}
				conditions = append(conditions, map[string]interface{}{
					"type":                 strOrEmpty(cm["type"]),
					"status":               strOrEmpty(cm["status"]),
					"reason":               strOrEmpty(cm["reason"]),
					"message":              strOrEmpty(cm["message"]),
					"last_transition_time": strOrEmpty(cm["lastTransitionTime"]),
				})
			}
		}
	}

	// recommendations
	var recommendations []map[string]interface{}
	if status != nil {
		if rec, ok := status["recommendation"].(map[string]interface{}); ok {
			if crs, ok := rec["containerRecommendations"].([]interface{}); ok && len(crs) > 0 {
				recommendations = make([]map[string]interface{}, 0, len(crs))
				for _, r := range crs {
					rm, _ := r.(map[string]interface{})
					if rm == nil {
						continue
					}
					recEntry := map[string]interface{}{
						"container_name": strOrEmpty(rm["containerName"]),
					}
					if t, ok := rm["target"].(map[string]interface{}); ok {
						recEntry["target"] = t
					}
					if l, ok := rm["lowerBound"].(map[string]interface{}); ok {
						recEntry["lower_bound"] = l
					}
					if u, ok := rm["upperBound"].(map[string]interface{}); ok {
						recEntry["upper_bound"] = u
					}
					if uc, ok := rm["uncappedTarget"].(map[string]interface{}); ok {
						recEntry["uncapped_target"] = uc
					}
					recommendations = append(recommendations, recEntry)
				}
			}
		}
	}

	cpuTarget := ""
	memoryTarget := ""
	if len(recommendations) > 0 {
		if t, ok := recommendations[0]["target"].(map[string]interface{}); ok {
			if c, ok := t["cpu"].(string); ok {
				cpuTarget = c
			}
			if m, ok := t["memory"].(string); ok {
				memoryTarget = m
			}
		}
	}

	provided := ""
	if len(conditions) > 0 {
		if s, ok := conditions[0]["status"].(string); ok {
			provided = s
		}
	}

	return map[string]interface{}{
		"name":               metadata["name"],
		"namespace":          metadata["namespace"],
		"target_ref":         targetRef,
		"target_ref_kind":    targetRefKind,
		"target_ref_name":    targetRefName,
		"update_mode":        updateMode,
		"container_policies": containerPolicies,
		"conditions":         conditions,
		"recommendations":    recommendations,
		"cpu_target":         cpuTarget,
		"memory_target":      memoryTarget,
		"provided":           provided,
		"labels":             metadata["labels"],
		"created_at":         metadata["creationTimestamp"],
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

// ========== helpers ==========

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

// hpaMetricSpecToMap — spec.metrics[i] raw map 를 list endpoint formatMetricSpec
// 와 같은 snake_case key 형태로 변환 (Resource/Pods/Object/External/ContainerResource).
func hpaMetricSpecToMap(m map[string]interface{}) map[string]interface{} {
	result := map[string]interface{}{
		"type": strOrEmpty(m["type"]),
	}
	mtype, _ := m["type"].(string)
	switch mtype {
	case "Resource":
		if res, ok := m["resource"].(map[string]interface{}); ok {
			result["resource_name"] = strOrEmpty(res["name"])
			if target, ok := res["target"].(map[string]interface{}); ok {
				ttype, _ := target["type"].(string)
				if ttype == "Utilization" {
					if v, ok := toInt64(target["averageUtilization"]); ok {
						result["target_average_utilization"] = v
						result["target_type"] = "Utilization"
					}
				} else if av, ok := target["averageValue"].(string); ok && av != "" {
					result["target_average_value"] = av
					result["target_type"] = "AverageValue"
				} else if v, ok := target["value"].(string); ok && v != "" {
					result["target_value"] = v
					result["target_type"] = "Value"
				}
			}
		}
	case "ContainerResource":
		if res, ok := m["containerResource"].(map[string]interface{}); ok {
			result["resource_name"] = strOrEmpty(res["name"])
			result["container_name"] = strOrEmpty(res["container"])
		}
	case "Pods":
		if p, ok := m["pods"].(map[string]interface{}); ok {
			if metric, ok := p["metric"].(map[string]interface{}); ok {
				result["metric_name"] = strOrEmpty(metric["name"])
			}
		}
	case "Object":
		if o, ok := m["object"].(map[string]interface{}); ok {
			if metric, ok := o["metric"].(map[string]interface{}); ok {
				result["metric_name"] = strOrEmpty(metric["name"])
			}
		}
	case "External":
		if e, ok := m["external"].(map[string]interface{}); ok {
			if metric, ok := e["metric"].(map[string]interface{}); ok {
				result["metric_name"] = strOrEmpty(metric["name"])
			}
		}
	}
	return result
}

// hpaMetricStatusToMap — status.currentMetrics[i] raw map 를 simplified
// snake_case shape 으로 변환.
func hpaMetricStatusToMap(m map[string]interface{}) map[string]interface{} {
	result := map[string]interface{}{
		"type": strOrEmpty(m["type"]),
	}
	mtype, _ := m["type"].(string)
	switch mtype {
	case "Resource":
		if res, ok := m["current"].(map[string]interface{}); ok {
			if v, ok := toInt64(res["averageUtilization"]); ok {
				result["current_average_utilization"] = v
			}
			if av, ok := res["averageValue"].(string); ok && av != "" {
				result["current_average_value"] = av
			}
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
