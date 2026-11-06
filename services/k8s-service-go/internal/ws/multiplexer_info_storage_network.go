package ws

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"

	ingressrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/ingress"
	pvcrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/pvc"
	scrow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/storageclass"
	varow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/volumeattachment"
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

// volumeAttachmentToInfo is the list's row (varow.Info), so a live update says what the list says.
func volumeAttachmentToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var va storagev1.VolumeAttachment
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &va); err != nil {
		return genericToInfo(obj)
	}
	return varow.Info(&va)
}

// ingressToInfo is the list's row (ingressrow.Info), so a live update says what the list says.
func ingressToInfo(obj *unstructured.Unstructured) map[string]interface{} {
	var ing networkingv1.Ingress
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &ing); err != nil {
		return genericToInfo(obj)
	}
	return ingressrow.Info(&ing)
}
