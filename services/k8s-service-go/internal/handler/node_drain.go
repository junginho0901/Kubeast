package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// DrainStatus tracks the status of a drain operation.
type DrainStatus struct {
	ID      string `json:"id"`
	Node    string `json:"node"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
	Created time.Time
}

var (
	drainStore   = make(map[string]*DrainStatus)
	drainStoreMu sync.RWMutex
)

func getDrainStatus(id string) *DrainStatus {
	drainStoreMu.RLock()
	defer drainStoreMu.RUnlock()
	return drainStore[id]
}

func setDrainStatus(ds *DrainStatus) {
	drainStoreMu.Lock()
	defer drainStoreMu.Unlock()
	drainStore[ds.ID] = ds

	// Cleanup old entries (>1 hour)
	for k, v := range drainStore {
		if time.Since(v.Created) > time.Hour {
			delete(drainStore, k)
		}
	}
}

// DrainNode handles POST /api/v1/nodes/{name}/drain.
func (h *Handler) DrainNode(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermission(r, "resource.node.drain"); err != nil {
		h.handleError(w, err)
		return
	}

	nodeName := chi.URLParam(r, "name")
	drainID := rand.String(12)

	ds := &DrainStatus{
		ID:      drainID,
		Node:    nodeName,
		Status:  "pending",
		Created: time.Now(),
	}
	setDrainStatus(ds)

	// Record the drain *acceptance* at request time. The async runDrain
	// may later complete or fail, but the user's intent is already audit-worthy.
	h.recordAuditWithPayload(r, "k8s.node.drain", "node", nodeName, "", nil,
		nil, audit.MustJSON(map[string]interface{}{"drain_id": drainID}))

	go h.runDrain(nodeName, drainID)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"drain_id": drainID,
		"status":   "accepted",
	})
}

// DrainNodeStatus handles GET /api/v1/nodes/{name}/drain/status.
func (h *Handler) DrainNodeStatus(w http.ResponseWriter, r *http.Request) {
	drainID := r.URL.Query().Get("drain_id")
	if drainID == "" {
		response.Error(w, http.StatusBadRequest, "drain_id is required")
		return
	}

	ds := getDrainStatus(drainID)
	if ds == nil {
		response.Error(w, http.StatusNotFound, "drain operation not found")
		return
	}

	response.JSON(w, http.StatusOK, ds)
}

func (h *Handler) runDrain(nodeName, drainID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	clientset := h.svc.Clientset()

	ds := getDrainStatus(drainID)
	ds.Status = "draining"
	setDrainStatus(ds)

	// Step 1: Cordon
	if err := h.svc.CordonNode(ctx, nodeName); err != nil {
		ds.Status = "error"
		ds.Message = fmt.Sprintf("cordon failed: %v", err)
		setDrainStatus(ds)
		return
	}

	// Step 2: List pods on node
	podList, err := clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("spec.nodeName=%s", nodeName),
	})
	if err != nil {
		ds.Status = "error"
		ds.Message = fmt.Sprintf("list pods failed: %v", err)
		setDrainStatus(ds)
		return
	}

	// Step 3: Filter and evict (same as Python: evict all, then mark success)
	evicted := 0
	for i := range podList.Items {
		pod := &podList.Items[i]
		if isDaemonSetPod(pod) {
			continue
		}
		if _, ok := pod.Annotations["kubernetes.io/config.mirror"]; ok {
			continue
		}

		if err := evictPod(ctx, clientset, pod); err != nil {
			slog.Warn("evict pod failed, force deleting", "pod", pod.Name, "ns", pod.Namespace, "err", err)
			grace := int64(0)
			_ = clientset.CoreV1().Pods(pod.Namespace).Delete(ctx, pod.Name, metav1.DeleteOptions{
				GracePeriodSeconds: &grace,
			})
		}
		evicted++
	}

	ds.Status = "success"
	ds.Message = fmt.Sprintf("drain completed, %d pods evicted", evicted)
	setDrainStatus(ds)
}

func isDaemonSetPod(pod *corev1.Pod) bool {
	for _, ref := range pod.OwnerReferences {
		if ref.Kind == "DaemonSet" {
			return true
		}
	}
	return false
}

func evictPod(ctx context.Context, clientset *kubernetes.Clientset, pod *corev1.Pod) error {
	eviction := &policyv1.Eviction{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pod.Name,
			Namespace: pod.Namespace,
		},
	}
	return clientset.PolicyV1().Evictions(pod.Namespace).Evict(ctx, eviction)
}
