package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// RequestMessage is the client request for a watch subscription.
type RequestMessage struct {
	Type      string `json:"type"`      // "REQUEST"
	ClusterID string `json:"clusterId"` // e.g. "default"
	Path      string `json:"path"`      // e.g. "/api/v1/pods"
	Query     string `json:"query"`     // e.g. "watch=true&..."
}

// ResponseMessage is sent back to the client.
type ResponseMessage struct {
	Type  string      `json:"type"`            // "DATA" or "ERROR"
	Path  string      `json:"path"`            // original path
	Query string      `json:"query"`           // original query string
	Data  interface{} `json:"data,omitempty"`  // watch event data
	Error interface{} `json:"error,omitempty"` // error info
}

type subscription struct {
	cancel context.CancelFunc
}

const maxSubscriptions = 200

// ClientProvider supplies K8s clients at use-time so hot-reload of the
// underlying clientBundle is transparent to long-lived subscriptions.
type ClientProvider interface {
	Clientset() *kubernetes.Clientset
	Dynamic() dynamic.Interface
}

// Multiplexer handles multiplexed WebSocket watch connections.
type Multiplexer struct {
	provider ClientProvider

	mu   sync.Mutex
	subs map[string]*subscription // key -> subscription
}

// NewMultiplexer creates a new WebSocket multiplexer.
func NewMultiplexer(p ClientProvider) *Multiplexer {
	return &Multiplexer{
		provider: p,
		subs:     make(map[string]*subscription),
	}
}

// HandleWebSocket handles the /wsMultiplexer endpoint.
func (m *Multiplexer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("ws upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	wsID := fmt.Sprintf("%p", conn)
	slog.Info("ws connected", "id", wsID)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Channel to send messages to client
	sendCh := make(chan ResponseMessage, 256)

	// Writer goroutine
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-sendCh:
				if !ok {
					return
				}
				data, err := json.Marshal(msg)
				if err != nil {
					continue
				}
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					return
				}
			}
		}
	}()

	var wsSubKeys []string
	defer func() {
		m.mu.Lock()
		for _, key := range wsSubKeys {
			if sub, ok := m.subs[key]; ok {
				sub.cancel()
				delete(m.subs, key)
			}
		}
		m.mu.Unlock()
		slog.Info("ws disconnected", "id", wsID)
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var req RequestMessage
		if err := json.Unmarshal(message, &req); err != nil {
			continue
		}

		key := fmt.Sprintf("%s:%s:%s?%s", wsID, req.ClusterID, req.Path, req.Query)

		switch req.Type {
		case "REQUEST":
			// Skip if already subscribed
			m.mu.Lock()
			if _, exists := m.subs[key]; exists {
				m.mu.Unlock()
				continue
			}

			// Reject if max subscriptions reached
			if len(m.subs) >= maxSubscriptions {
				m.mu.Unlock()
				sendCh <- ResponseMessage{
					Type:  "ERROR",
					Path:  req.Path,
					Query: req.Query,
					Error: map[string]string{"message": fmt.Sprintf("max subscriptions reached (%d), cannot create new watch", maxSubscriptions)},
				}
				continue
			}

			subCtx, subCancel := context.WithCancel(ctx)
			m.subs[key] = &subscription{cancel: subCancel}
			wsSubKeys = append(wsSubKeys, key)
			m.mu.Unlock()

			go m.runWatch(subCtx, req.Path, req.Query, sendCh)

		case "CLOSE":
			m.mu.Lock()
			if sub, ok := m.subs[key]; ok {
				sub.cancel()
				delete(m.subs, key)
			}
			m.mu.Unlock()
		}
	}
}

func (m *Multiplexer) runWatch(ctx context.Context, path, queryStr string, sendCh chan<- ResponseMessage) {
	resource, namespace, err := parsePath(path)
	if err != nil {
		sendCh <- ResponseMessage{Type: "ERROR", Path: path, Query: queryStr, Error: map[string]string{"message": err.Error()}}
		return
	}

	params := parseQuery(queryStr)
	_ = params // For future use (label_selector, field_selector, etc.)

	gvr, ok := resourceToGVR(resource)
	if !ok {
		sendCh <- ResponseMessage{Type: "ERROR", Path: path, Query: queryStr, Error: map[string]string{"message": "unsupported resource: " + resource}}
		return
	}

	var lastResourceVersion string

	for {
		if ctx.Err() != nil {
			return
		}

		opts := metav1.ListOptions{
			Watch:           true,
			TimeoutSeconds:  int64Ptr(300),
			ResourceVersion: lastResourceVersion,
		}

		dyn := m.provider.Dynamic()
		if dyn == nil {
			slog.Warn("watch skipped: kubeconfig not loaded", "resource", resource)
			sendCh <- ResponseMessage{Type: "ERROR", Path: path, Query: queryStr, Error: map[string]string{"message": "kubeconfig not loaded"}}
			return
		}
		var watcher watch.Interface
		if namespace != "" {
			watcher, err = dyn.Resource(gvr).Namespace(namespace).Watch(ctx, opts)
		} else {
			watcher, err = dyn.Resource(gvr).Watch(ctx, opts)
		}
		if err != nil {
			slog.Warn("watch failed", "resource", resource, "err", err)
			sendCh <- ResponseMessage{Type: "ERROR", Path: path, Query: queryStr, Error: map[string]string{"message": err.Error()}}
			time.Sleep(5 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			if ctx.Err() != nil {
				watcher.Stop()
				return
			}

			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}

			rv := obj.GetResourceVersion()
			if rv != "" {
				lastResourceVersion = rv
			}

			info := objectToInfo(resource, obj)

			sendCh <- ResponseMessage{
				Type:  "DATA",
				Path:  path,
				Query: queryStr,
				Data: map[string]interface{}{
					"type":   string(event.Type),
					"object": info,
				},
			}
		}

		// Watch ended, retry
		if ctx.Err() != nil {
			return
		}
		time.Sleep(1 * time.Second)
	}
}

// parsePath extracts resource type and optional namespace from K8s API path.
func parsePath(path string) (resource string, namespace string, err error) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 3 || parts[0] != "api" || parts[1] != "v1" {
		// Try apps/v1 style: /apis/apps/v1/...
		if len(parts) >= 4 && parts[0] == "apis" {
			if len(parts) == 4 {
				return parts[3], "", nil
			}
			if len(parts) >= 6 && parts[3] == "namespaces" {
				return parts[5], parts[4], nil
			}
		}
		return "", "", fmt.Errorf("unsupported api path: %s", path)
	}

	// /api/v1/pods
	if len(parts) == 3 {
		return parts[2], "", nil
	}

	// /api/v1/namespaces/{ns}/pods
	if len(parts) >= 5 && parts[2] == "namespaces" {
		return parts[4], parts[3], nil
	}

	return "", "", fmt.Errorf("unsupported api path: %s", path)
}

func parseQuery(queryStr string) map[string]string {
	result := make(map[string]string)
	values, err := url.ParseQuery(queryStr)
	if err != nil {
		return result
	}
	for k, v := range values {
		if len(v) > 0 && k != "watch" {
			result[k] = v[0]
		}
	}
	return result
}

func resourceToGVR(resource string) (schema.GroupVersionResource, bool) {
	gvrMap := map[string]schema.GroupVersionResource{
		"pods":              {Group: "", Version: "v1", Resource: "pods"},
		"services":          {Group: "", Version: "v1", Resource: "services"},
		"nodes":             {Group: "", Version: "v1", Resource: "nodes"},
		"namespaces":        {Group: "", Version: "v1", Resource: "namespaces"},
		"events":            {Group: "", Version: "v1", Resource: "events"},
		"persistentvolumeclaims": {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
		"pvcs":              {Group: "", Version: "v1", Resource: "persistentvolumeclaims"},
		"persistentvolumes": {Group: "", Version: "v1", Resource: "persistentvolumes"},
		"pvs":               {Group: "", Version: "v1", Resource: "persistentvolumes"},
		"configmaps":        {Group: "", Version: "v1", Resource: "configmaps"},
		"secrets":           {Group: "", Version: "v1", Resource: "secrets"},
		"endpoints":         {Group: "", Version: "v1", Resource: "endpoints"},
		"deployments":       {Group: "apps", Version: "v1", Resource: "deployments"},
		"statefulsets":      {Group: "apps", Version: "v1", Resource: "statefulsets"},
		"daemonsets":        {Group: "apps", Version: "v1", Resource: "daemonsets"},
		"replicasets":       {Group: "apps", Version: "v1", Resource: "replicasets"},
		"ingresses":         {Group: "networking.k8s.io", Version: "v1", Resource: "ingresses"},
		"ingressclasses":    {Group: "networking.k8s.io", Version: "v1", Resource: "ingressclasses"},
		"networkpolicies":   {Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
		"endpointslices":    {Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices"},
		"jobs":              {Group: "batch", Version: "v1", Resource: "jobs"},
		"cronjobs":          {Group: "batch", Version: "v1", Resource: "cronjobs"},
		"storageclasses":    {Group: "storage.k8s.io", Version: "v1", Resource: "storageclasses"},
		"volumeattachments": {Group: "storage.k8s.io", Version: "v1", Resource: "volumeattachments"},
		"gateways":          {Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"},
		"gatewayclasses":    {Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gatewayclasses"},
		"httproutes":        {Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"},
		"serviceaccounts":   {Group: "", Version: "v1", Resource: "serviceaccounts"},
		"roles":                      {Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
		"horizontalpodautoscalers":    {Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
		"verticalpodautoscalers":      {Group: "autoscaling.k8s.io", Version: "v1", Resource: "verticalpodautoscalers"},
	}
	gvr, ok := gvrMap[resource]
	return gvr, ok
}

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

	return map[string]interface{}{
		"name":      metadata["name"],
		"namespace": metadata["namespace"],
		"phase":     phase,
		"status":    phase,
		"node_name": nodeName,
		"pod_ip":    podIP,
		"labels":    metadata["labels"],
		"created_at": metadata["creationTimestamp"],
	}
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
	return map[string]interface{}{
		"name":       metadata["name"],
		"namespace":  metadata["namespace"],
		"kind":       obj.GetKind(),
		"labels":     metadata["labels"],
		"created_at": metadata["creationTimestamp"],
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
