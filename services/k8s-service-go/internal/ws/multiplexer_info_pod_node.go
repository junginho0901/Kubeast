package ws

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/podrow"
)

// podToInfo is the list's row (podrow.Info), so a live update says what the list says.
func podToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	return podrow.Info(podrow.FromObject(obj.Object))
}

// nodeToInfo — list endpoint: formatNodeSummary (nodes.go).
func nodeToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	metadata, _ := obj.Object["metadata"].(map[string]interface{})
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
	// kubectl's order, as formatNodeSummary: in a map's order the opening update of a Node drawer differed from its answer
	sort.Strings(roles)

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
