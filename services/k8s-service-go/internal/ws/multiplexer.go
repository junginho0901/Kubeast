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

// Multiplexer handles multiplexed WebSocket watch connections.
type Multiplexer struct {
	clientset *kubernetes.Clientset
	dynamic   dynamic.Interface

	mu   sync.Mutex
	subs map[string]*subscription // key -> subscription
}

// NewMultiplexer creates a new WebSocket multiplexer.
func NewMultiplexer(clientset *kubernetes.Clientset, dynClient dynamic.Interface) *Multiplexer {
	return &Multiplexer{
		clientset: clientset,
		dynamic:   dynClient,
		subs:      make(map[string]*subscription),
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

		var watcher watch.Interface
		if namespace != "" {
			watcher, err = m.dynamic.Resource(gvr).Namespace(namespace).Watch(ctx, opts)
		} else {
			watcher, err = m.dynamic.Resource(gvr).Watch(ctx, opts)
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
				if role != "" {
					roles = append(roles, role)
				}
			}
		}
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

	return map[string]interface{}{
		"name":              metadata["name"],
		"status":            nodeStatus,
		"unschedulable":     unschedulable,
		"roles":             roles,
		"internal_ip":       internalIP,
		"external_ip":       externalIP,
		"os_image":          osImage,
		"kernel_version":    kernelVersion,
		"container_runtime": containerRuntime,
		"kubelet_version":   kubeletVersion,
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

func int64Ptr(i int64) *int64 {
	return &i
}
