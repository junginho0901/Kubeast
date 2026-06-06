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
	"github.com/junginho0901/kubeast/services/pkg/cluster"
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

// WebSocket keepalive parameters.
//
// nginx proxy_read_timeout 기본값 60초 → 60초 동안 watch 이벤트 없으면
// connection 이 idle 로 판단되어 끊김. 60초 사이의 K8s 변화는 영원히 lost
// (새 watch 시작 시 LIST 안 보냄). 해결: 25초마다 ws ping 보내 nginx 가
// traffic 으로 인식하게. ReadDeadline 은 dead connection 빠른 정리용.
const (
	pingPeriod = 25 * time.Second
	pongWait   = 60 * time.Second
	writeWait  = 10 * time.Second
)

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
	// DynamicForCtx targets the cluster carried in ctx (value-or-nil).
	DynamicForCtx(ctx context.Context) dynamic.Interface
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

	// Keepalive: pong 받을 때마다 ReadDeadline 갱신. 60초 안에 pong 없으면
	// ReadMessage 가 timeout 으로 break → defer 의 disconnect 처리.
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Channel to send messages to client
	sendCh := make(chan ResponseMessage, 256)

	// Writer goroutine — DATA/ERROR 메시지 송신 + 25초마다 ping.
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
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
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					return
				}
			case <-ticker.C:
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
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
			// Carry the target cluster so the watch hits the right cluster.
			if req.ClusterID != "" {
				subCtx = cluster.WithID(subCtx, cluster.ID(req.ClusterID))
			}
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
	labelSelector := params["labelSelector"]
	fieldSelector := params["fieldSelector"]

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
			LabelSelector:   labelSelector,
			FieldSelector:   fieldSelector,
		}

		dyn := m.provider.DynamicForCtx(ctx)
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

			// gvr.Resource 가 정식 K8s 이름 (e.g. "persistentvolumes").
			// resource 변수는 path 의 raw segment 라 alias ("pvs", "pvcs") 가
			// 그대로 넘어옴 → objectToInfo switch 에 case 없어 default
			// genericToInfo 가 호출되어 partial object 만 보내는 버그.
			// 정식 이름 사용으로 매번 정확한 *ToInfo 호출 보장.
			info := objectToInfo(gvr.Resource, obj)

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

