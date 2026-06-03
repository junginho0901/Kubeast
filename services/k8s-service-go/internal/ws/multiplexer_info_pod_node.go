package ws

import (
	"fmt"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

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
