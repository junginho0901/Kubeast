package handler

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/rand"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
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
	if err := h.requirePermissionForCluster(r, "resource.node.drain"); err != nil {
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

	// The drain outlives the request: carry only the selected cluster id into
	// the background context so the goroutine targets the same cluster.
	bg := context.Background()
	if id, ok := cluster.FromContext(r.Context()); ok {
		bg = cluster.WithID(bg, id)
	}
	if p, ok := auth.FromContext(r.Context()); ok { // evictions are made as the user (impersonation)
		bg = auth.WithPayload(bg, p)
	}
	go h.runDrain(bg, nodeName, drainID)

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"drain_id": drainID,
		"status":   "accepted",
	})
}

// DrainNodeStatus handles GET /api/v1/nodes/{name}/drain/status.
func (h *Handler) DrainNodeStatus(w http.ResponseWriter, r *http.Request) {
	// Gate the status read on the same per-cluster permission as starting a drain,
	// so it isn't protected by the opaque drain_id alone.
	if err := h.requirePermissionForCluster(r, "resource.node.drain"); err != nil {
		h.handleError(w, err)
		return
	}
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

func (h *Handler) runDrain(parent context.Context, nodeName, drainID string) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()

	ds := getDrainStatus(drainID)
	ds.Status = "draining"
	setDrainStatus(ds)

	clientset, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		ds.Status = "error"
		ds.Message = fmt.Sprintf("cluster client: %v", err)
		setDrainStatus(ds)
		return
	}

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

	// Step 3: evict through the Eviction API so PodDisruptionBudgets are
	// honoured. A PDB answers 429: retry until the deadline, never force-delete.
	// Pods still on the node at the end are reported and the node stays cordoned.
	var candidates []corev1.Pod
	for _, pod := range podList.Items {
		if isDaemonSetPod(&pod) {
			continue
		}
		if _, ok := pod.Annotations["kubernetes.io/config.mirror"]; ok {
			continue
		}
		candidates = append(candidates, pod)
	}

	if blocked := evictAll(ctx, clientset, candidates); len(blocked) > 0 {
		slog.Warn("drain incomplete", "node", nodeName, "blocked", len(blocked))
		ds.Status = "error"
		ds.Message = fmt.Sprintf("drain incomplete: %d of %d pods could not be evicted (node stays cordoned): %s",
			len(blocked), len(candidates), strings.Join(blocked, "; "))
		setDrainStatus(ds)
		return
	}
	if err := waitForPodsGone(ctx, clientset, candidates); err != nil {
		ds.Status = "error"
		ds.Message = fmt.Sprintf("drain incomplete: %v (node stays cordoned)", err)
		setDrainStatus(ds)
		return
	}

	ds.Status = "success"
	ds.Message = fmt.Sprintf("drain completed, %d pods evicted", len(candidates))
	setDrainStatus(ds)
}

// evictRetryInterval is how long to wait before retrying an eviction a
// PodDisruptionBudget rejected (kubectl drain uses 5s). A var so tests can shrink it.
var evictRetryInterval = 5 * time.Second

// evictAll evicts the pods concurrently (as kubectl drain does, so one pod
// held by a PDB does not starve the others) and returns "ns/name: reason" for
// the ones that could not be evicted before the deadline.
func evictAll(ctx context.Context, cs kubernetes.Interface, pods []corev1.Pod) []string {
	var (
		mu      sync.Mutex
		wg      sync.WaitGroup
		blocked []string
	)
	for i := range pods {
		wg.Add(1)
		go func(pod *corev1.Pod) {
			defer wg.Done()
			if err := evictWithRetry(ctx, cs, pod); err != nil {
				mu.Lock()
				blocked = append(blocked, fmt.Sprintf("%s/%s: %v", pod.Namespace, pod.Name, err))
				mu.Unlock()
			}
		}(&pods[i])
	}
	wg.Wait()
	sort.Strings(blocked)
	return blocked
}

func evictWithRetry(ctx context.Context, cs kubernetes.Interface, pod *corev1.Pod) error {
	for {
		err := evictPod(ctx, cs, pod)
		switch {
		case err == nil, apierrors.IsNotFound(err):
			return nil
		case apierrors.IsTooManyRequests(err): // blocked by a PodDisruptionBudget
			select {
			case <-ctx.Done():
				return fmt.Errorf("blocked by PodDisruptionBudget until the drain deadline: %v", err)
			case <-time.After(evictRetryInterval):
			}
		default:
			return err
		}
	}
}

// waitForPodsGone waits until none of the evicted pods (by UID) exist any more.
func waitForPodsGone(ctx context.Context, cs kubernetes.Interface, pods []corev1.Pod) error {
	for {
		remaining := 0
		for i := range pods {
			p, err := cs.CoreV1().Pods(pods[i].Namespace).Get(ctx, pods[i].Name, metav1.GetOptions{})
			if err == nil && p.UID == pods[i].UID {
				remaining++
			}
		}
		if remaining == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("timed out waiting for %d pods to terminate", remaining)
		case <-time.After(2 * time.Second):
		}
	}
}

func isDaemonSetPod(pod *corev1.Pod) bool {
	for _, ref := range pod.OwnerReferences {
		if ref.Kind == "DaemonSet" {
			return true
		}
	}
	return false
}

func evictPod(ctx context.Context, clientset kubernetes.Interface, pod *corev1.Pod) error {
	eviction := &policyv1.Eviction{
		ObjectMeta: metav1.ObjectMeta{
			Name:      pod.Name,
			Namespace: pod.Namespace,
		},
	}
	return clientset.PolicyV1().Evictions(pod.Namespace).Evict(ctx, eviction)
}
