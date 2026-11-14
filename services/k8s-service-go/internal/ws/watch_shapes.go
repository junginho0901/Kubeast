package ws

import "k8s.io/apimachinery/pkg/runtime/schema"

// watchShapes is what objectToInfo reads of each kind the W2 load test's screens kept open in numbers (pods of a node or
// a namespace, the node list, deployments), the rest of an object being skipped in the bytes (watch_decode.go). Every
// shape keeps metadata.resourceVersion, which a watch resumes from. A field a row starts to read has to be added here:
// TestRowsOfTheDecodedPartAreTheRowsOfTheWholeObject compares the rows over random objects.
var watchShapes = map[schema.GroupKind]*shape{
	{Group: "", Kind: "Pod"}:            podShape,
	{Group: "", Kind: "Node"}:           nodeShape,
	{Group: "apps", Kind: "Deployment"}: deploymentShape,
}

// podShape is what podrow.FromObject reads (TestFromObjectReadsWhatInfoReads holds it to podrow.Info): no annotation, field
// manager or environment value, nor probes, tolerations or affinity.
var podShape = fields(map[string]*shape{
	"apiVersion": nil,
	"kind":       nil,
	"metadata": fields(map[string]*shape{
		"name": nil, "namespace": nil, "resourceVersion": nil, "creationTimestamp": nil, "deletionTimestamp": nil, "labels": nil,
		"ownerReferences": fields(map[string]*shape{"kind": nil, "name": nil, "uid": nil, "controller": nil}),
	}),
	"spec": fields(map[string]*shape{
		"nodeName": nil, "serviceAccountName": nil, "priorityClassName": nil, "runtimeClassName": nil,
		"containers":       podContainerShape,
		"initContainers":   podContainerShape,
		"imagePullSecrets": fields(map[string]*shape{"name": nil}),
		"resourceClaims":   fields(map[string]*shape{"name": nil, "resourceClaimName": nil, "resourceClaimTemplateName": nil}),
		"volumes": fields(map[string]*shape{
			"name": nil, "configMap": fields(map[string]*shape{"name": nil}), "secret": fields(map[string]*shape{"secretName": nil}),
			"projected": fields(map[string]*shape{"sources": fields(map[string]*shape{
				"configMap": fields(map[string]*shape{"name": nil}), "secret": fields(map[string]*shape{"name": nil}),
			})}),
		}),
	}),
	"status": fields(map[string]*shape{
		"phase": nil, "reason": nil, "message": nil, "podIP": nil,
		"conditions":            fields(map[string]*shape{"type": nil, "status": nil, "reason": nil}),
		"containerStatuses":     containerStatusShape,
		"initContainerStatuses": containerStatusShape,
	}),
})

var podContainerShape = fields(map[string]*shape{
	"name": nil, "image": nil, "ports": nil, "resources": nil, "securityContext": nil, "command": nil, "args": nil, "restartPolicy": nil,
	"volumeMounts": fields(map[string]*shape{"name": nil, "mountPath": nil, "readOnly": nil}),
	"env": fields(map[string]*shape{"name": nil, "valueFrom": fields(map[string]*shape{
		"configMapKeyRef": fields(map[string]*shape{"name": nil}), "secretKeyRef": fields(map[string]*shape{"name": nil}),
	})}),
	"envFrom": fields(map[string]*shape{
		"prefix": nil, "configMapRef": fields(map[string]*shape{"name": nil, "optional": nil}), "secretRef": fields(map[string]*shape{"name": nil, "optional": nil}),
	}),
})

var containerStatusShape = fields(map[string]*shape{
	"name": nil, "ready": nil, "started": nil, "restartCount": nil, "state": nil, "lastState": nil,
})

// nodeShape is what nodeToInfo reads: no image list, annotation, field manager, heartbeat or condition message.
var nodeShape = fields(map[string]*shape{
	"apiVersion": nil,
	"kind":       nil,
	"metadata":   fields(map[string]*shape{"name": nil, "resourceVersion": nil, "creationTimestamp": nil, "labels": nil}),
	"spec":       fields(map[string]*shape{"unschedulable": nil, "taints": nil}),
	"status": fields(map[string]*shape{
		"conditions": fields(map[string]*shape{"type": nil, "status": nil, "reason": nil}),
		"addresses":  nil, "capacity": nil, "allocatable": nil,
		"nodeInfo": fields(map[string]*shape{"osImage": nil, "kernelVersion": nil, "containerRuntimeVersion": nil, "kubeletVersion": nil}),
	}),
})

// deploymentShape is what slimWorkload leaves of a Deployment for deploymentToInfo: no field manager or annotation, and of
// the pod template each container's name and image.
var deploymentShape = &shape{others: true, fields: map[string]*shape{
	"metadata": {others: true, fields: map[string]*shape{"managedFields": skip, "annotations": skip}},
	"spec": {others: true, fields: map[string]*shape{
		"template": fields(map[string]*shape{"spec": fields(map[string]*shape{"containers": fields(map[string]*shape{"name": nil, "image": nil})})}),
	}},
}}
