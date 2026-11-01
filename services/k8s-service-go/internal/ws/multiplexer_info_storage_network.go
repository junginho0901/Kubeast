package ws

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	pvcrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/pvc"
	scrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/storageclass"
)

// pvcToInfo is the list's row (pvcrow.Info), so a live update says what the list says.
func pvcToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var c corev1.PersistentVolumeClaim
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &c); err != nil {
		return genericToInfo(obj)
	}
	return pvcrow.Info(&c)
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

// storageclassToInfo is the list's row (scrow.Info), so a live update says what the list says.
func storageclassToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var sc storagev1.StorageClass
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &sc); err != nil {
		return genericToInfo(obj)
	}
	return scrow.Info(&sc)
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
