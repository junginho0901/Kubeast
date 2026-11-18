package handler

import (
	"context"
	"errors"
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

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/drains"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// DrainStatus is a drain as the status route answers it, from node_drains, so
// any replica answers it.
type DrainStatus struct {
	ID         string     `json:"id"`
	Node       string     `json:"node"`
	Status     string     `json:"status"`
	Message    string     `json:"message,omitempty"`
	PodsTotal  *int       `json:"pods_total,omitempty"`
	PodsDone   *int       `json:"pods_done,omitempty"`
	Created    time.Time  `json:"Created"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	// CordonedNodes are the drain's nodes still cordoned, read from the cluster
	// as the caller when a drain ended without success: [] when none is, null
	// when they were not read (no omitempty, or [] would read as not read).
	CordonedNodes []string `json:"cordoned_nodes"`
	// Cluster is where the drain runs; its status is read on that cluster only.
	Cluster cluster.ID `json:"-"`
}

func drainStatusOf(r *drains.Row) *DrainStatus {
	return &DrainStatus{ID: r.ID, Node: r.Node, Status: r.Status, Message: r.Message, PodsTotal: r.PodsTotal, PodsDone: r.PodsDone,
		Created: r.StartedAt, FinishedAt: r.FinishedAt, Cluster: cluster.ID(r.Cluster)}
}

// DrainNode handles POST /api/v1/nodes/{name}/drain.
func (h *Handler) DrainNode(w http.ResponseWriter, r *http.Request) {
	if err := h.requirePermissionForCluster(r, "resource.node.drain"); err != nil {
		h.handleError(w, err)
		return
	}

	nodeName := chi.URLParam(r, "name")
	drainID := rand.String(12)
	clusterID, _ := cluster.FromContext(r.Context())
	started := audit.MustJSON(map[string]interface{}{"drain_id": drainID, "phase": "started"})
	if h.drains == nil {
		h.recordAuditWithPayload(r, "k8s.node.drain", "node", nodeName, "", errDrainStore, nil, started)
		response.Error(w, http.StatusServiceUnavailable, errDrainStore.Error())
		return
	}

	// The drain outlives the request: carry only the selected cluster id into
	// the background context so the goroutine targets the same cluster.
	bg := context.Background()
	if id, ok := cluster.FromContext(r.Context()); ok {
		bg = cluster.WithID(bg, id)
	}
	payload, hasPayload := auth.FromContext(r.Context())
	if hasPayload { // evictions are made as the user (impersonation)
		bg = auth.WithPayload(bg, payload)
	}
	runCtx, cancel := context.WithCancel(bg)

	// Its finished row comes from the replica that ends it, with this request's actor and address.
	end := auditBase(r, audit.ServiceK8s, "k8s.node.drain", "node", nodeName, "")
	row := drains.Row{ID: drainID, Cluster: string(clusterID), Node: nodeName, UserID: payload.UserID, UserEmail: payload.Email}
	if err := h.drains.Begin(r.Context(), row, end, cancel); err != nil {
		cancel()
		if errors.Is(err, drains.ErrShuttingDown) {
			h.recordAuditWithPayload(r, "k8s.node.drain", "node", nodeName, "", fmt.Errorf("drain not started: %w", err), nil, started)
			response.Error(w, http.StatusServiceUnavailable, "this server is shutting down; start the drain again")
			return
		}
		h.recordAuditWithPayload(r, "k8s.node.drain", "node", nodeName, "", fmt.Errorf("drain progress not saved: %w", err), nil, started)
		response.Error(w, http.StatusServiceUnavailable, "drain progress could not be saved")
		return
	}

	// Record the drain's acceptance now and its outcome when it ends (phase
	// finished) — a drain that cannot evict a pod is a failure, not the
	// acceptance's success.
	h.recordAuditWithPayload(r, "k8s.node.drain", "node", nodeName, "", nil, nil, started)

	go func() {
		defer cancel()
		status, message := h.runDrain(runCtx, nodeName, drainID)
		h.drains.Finish(drainID, status, message)
	}()

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"drain_id": drainID,
		"status":   "accepted",
	})
}

var errDrainStore = errors.New("drain progress store unavailable")

// DrainNodeStatus handles GET /api/v1/nodes/{name}/drain/status.
func (h *Handler) DrainNodeStatus(w http.ResponseWriter, r *http.Request) {
	// Gate the status read on the same per-cluster permission as starting a drain,
	// so it isn't protected by the opaque drain_id alone; a drain of another
	// cluster is not found here.
	if err := h.requirePermissionForCluster(r, "resource.node.drain"); err != nil {
		h.handleError(w, err)
		return
	}
	drainID := r.URL.Query().Get("drain_id")
	if drainID == "" {
		response.Error(w, http.StatusBadRequest, "drain_id is required")
		return
	}
	if h.drains == nil {
		response.Error(w, http.StatusServiceUnavailable, errDrainStore.Error())
		return
	}

	clusterID, _ := cluster.FromContext(r.Context())
	row, err := h.drains.Status(r.Context(), drainID)
	if err != nil {
		slog.Warn("drain: status read failed", "id", drainID, "err", err)
		response.Error(w, http.StatusServiceUnavailable, "drain progress could not be read")
		return
	}
	if row == nil || cluster.ID(row.Cluster) != clusterID {
		response.Error(w, http.StatusNotFound, "drain operation not found")
		return
	}
	ds := drainStatusOf(row)
	if ds.Status == drains.StatusInterrupted || ds.Status == drains.StatusError {
		ds.CordonedNodes = h.cordonedNodes(r.Context(), []string{ds.Node})
	}
	response.JSON(w, http.StatusOK, ds)
}

// cordonedNodes reads the nodes as the caller and returns those still
// cordoned; nil when they could not be read, so the screen says nothing it
// did not read.
func (h *Handler) cordonedNodes(ctx context.Context, names []string) []string {
	if h.svc == nil {
		return nil
	}
	cs, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return nil
	}
	return cordonedOf(ctx, cs, names)
}

func cordonedOf(ctx context.Context, cs kubernetes.Interface, names []string) []string {
	cordoned := []string{}
	for _, name := range names {
		node, err := cs.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil
		}
		if node.Spec.Unschedulable {
			cordoned = append(cordoned, name)
		}
	}
	return cordoned
}

// runDrain cordons the node and evicts its pods, writing its progress to the
// drain's row, and returns how it ended. The cordon and every eviction wait
// while this server's drain heartbeat is not being saved (drains.Tracker.Ready).
func (h *Handler) runDrain(parent context.Context, nodeName, drainID string) (status, message string) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Minute)
	defer cancel()

	h.drains.Progress(drainID, drains.Progress{Status: drains.StatusDraining})

	clientset, err := h.svc.ClientsetFor(ctx)
	if err != nil {
		return drains.StatusError, fmt.Sprintf("cluster client: %v", err)
	}

	// Step 1: Cordon
	if err := h.drains.Ready(ctx); err != nil {
		return drains.StatusError, fmt.Sprintf("not cordoned: %v", err)
	}
	if err := h.svc.CordonNode(ctx, nodeName); err != nil {
		return drains.StatusError, fmt.Sprintf("cordon failed: %v", err)
	}

	// Step 2: List pods on node
	podList, err := clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("spec.nodeName=%s", nodeName),
	})
	if err != nil {
		return drains.StatusError, fmt.Sprintf("list pods failed: %v", err)
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
	total, done := len(candidates), 0
	h.drains.Progress(drainID, drains.Progress{PodsTotal: &total, PodsDone: &done})

	if blocked := evictAll(ctx, clientset, candidates, h.drains.Ready); len(blocked) > 0 {
		slog.Warn("drain incomplete", "node", nodeName, "blocked", len(blocked))
		return drains.StatusError, fmt.Sprintf("drain incomplete: %d of %d pods could not be evicted (node stays cordoned): %s",
			len(blocked), len(candidates), strings.Join(blocked, "; "))
	}
	gone := func(left int) {
		n := total - left
		h.drains.Progress(drainID, drains.Progress{PodsDone: &n})
	}
	if err := waitForPodsGone(ctx, clientset, candidates, gone); err != nil {
		return drains.StatusError, fmt.Sprintf("drain incomplete: %v (node stays cordoned)", err)
	}
	return drains.StatusSuccess, fmt.Sprintf("drain completed, %d pods evicted", len(candidates))
}

// evictRetryInterval is how long to wait before retrying an eviction a
// PodDisruptionBudget rejected (kubectl drain uses 5s). A var so tests can shrink it.
var evictRetryInterval = 5 * time.Second

// evictAll evicts the pods concurrently (as kubectl drain does, so one pod
// held by a PDB does not starve the others) and returns "ns/name: reason" for
// the ones that could not be evicted before the deadline. ready (nil: none)
// is waited for before each eviction call.
func evictAll(ctx context.Context, cs kubernetes.Interface, pods []corev1.Pod, ready func(context.Context) error) []string {
	var (
		mu      sync.Mutex
		wg      sync.WaitGroup
		blocked []string
	)
	for i := range pods {
		wg.Add(1)
		go func(pod *corev1.Pod) {
			defer wg.Done()
			if err := evictWithRetry(ctx, cs, pod, ready); err != nil {
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

func evictWithRetry(ctx context.Context, cs kubernetes.Interface, pod *corev1.Pod, ready func(context.Context) error) error {
	for {
		if ready != nil {
			if err := ready(ctx); err != nil {
				return err
			}
		}
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

// waitForPodsGone waits until none of the evicted pods (by UID) exist any
// more, telling left (when not nil) how many remain each time that changes.
func waitForPodsGone(ctx context.Context, cs kubernetes.Interface, pods []corev1.Pod, left func(int)) error {
	last := len(pods)
	for {
		remaining := 0
		for i := range pods {
			p, err := cs.CoreV1().Pods(pods[i].Namespace).Get(ctx, pods[i].Name, metav1.GetOptions{})
			if err == nil && p.UID == pods[i].UID {
				remaining++
			}
		}
		if remaining != last && left != nil {
			left(remaining)
		}
		last = remaining
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
