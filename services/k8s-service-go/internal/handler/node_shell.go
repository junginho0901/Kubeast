package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// nodeShellImage picks the debug image: the first allowed image when none was
// requested, or the requested one if it is on the allow list.
func nodeShellImage(allowed []string, requested string) (string, error) {
	var list []string
	for _, a := range allowed {
		if a = strings.TrimSpace(a); a != "" {
			list = append(list, a)
		}
	}
	if len(list) == 0 {
		return requested, fmt.Errorf("no node shell image is allowed (NODE_SHELL_IMAGES is empty)")
	}
	if requested == "" {
		return list[0], nil
	}
	for _, a := range list {
		if a == requested {
			return requested, nil
		}
	}
	return requested, fmt.Errorf("image %q is not on the node shell allow list (%s)", requested, strings.Join(list, ", "))
}

// ensureNodeShellNamespace creates the namespace the privileged debug pods run
// in, labelled for the Pod Security Admission "privileged" level so the rest
// of the cluster can stay restricted.
func ensureNodeShellNamespace(ctx context.Context, cs kubernetes.Interface, name string) error {
	if _, err := cs.CoreV1().Namespaces().Get(ctx, name, metav1.GetOptions{}); err == nil {
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name: name,
		Labels: map[string]string{
			"pod-security.kubernetes.io/enforce": "privileged",
			"pod-security.kubernetes.io/audit":   "privileged",
			"pod-security.kubernetes.io/warn":    "privileged",
			"app.kubernetes.io/managed-by":       "kubeast",
		},
	}}
	_, err := cs.CoreV1().Namespaces().Create(ctx, ns, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	return err
}

func int64p(v int64) *int64 { return &v }

// shellStatus is a text frame telling the terminal how the node shell is
// getting on, for the UI to show in the user's language. Reason and message
// are the Kubernetes values (ImagePullBackOff, the kubelet's text).
type shellStatus struct {
	Type    string `json:"type"` // always "status"
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	Seconds int    `json:"seconds,omitempty"`
}

// Node shell statuses.
const (
	shellWaiting          = "waiting"           // debug pod created, not running yet (reason: why)
	shellStarting         = "starting"          // running; attaching
	shellTimeout          = "timeout"           // did not start within seconds (reason: last seen)
	shellExited           = "exited"            // ended before the shell opened
	shellFailed           = "failed"            // could not create or reach the debug pod
	shellImageRejected    = "image-rejected"    // the requested image is not on the allow list
	shellAuditUnavailable = "audit-unavailable" // the audit row could not be written; no shell
)

const shellStatusMessageMax = 500

func writeShellStatus(conn *websocket.Conn, s shellStatus) {
	s.Type = "status"
	if len(s.Message) > shellStatusMessageMax {
		s.Message = strings.ToValidUTF8(s.Message[:shellStatusMessageMax], "") + "…"
	}
	b, _ := json.Marshal(s)
	_ = conn.WriteMessage(websocket.TextMessage, b)
}

// Debug pod start states read off the pod.
const (
	podStartPending = iota
	podStartRunning
	podStartEnded
)

// podStartState says whether the single-container debug pod is still coming
// up, running, or ended, with the Kubernetes reason and message for the first
// and last (container waiting/terminated state first, then the pod's).
func podStartState(pod *corev1.Pod) (state int, reason, message string) {
	var cs *corev1.ContainerStatus
	if len(pod.Status.ContainerStatuses) > 0 {
		cs = &pod.Status.ContainerStatuses[0]
	}
	switch pod.Status.Phase {
	case corev1.PodRunning:
		return podStartRunning, "", ""
	case corev1.PodFailed, corev1.PodSucceeded:
		if cs != nil && cs.State.Terminated != nil {
			return podStartEnded, cs.State.Terminated.Reason, cs.State.Terminated.Message
		}
		if pod.Status.Reason != "" {
			return podStartEnded, pod.Status.Reason, pod.Status.Message
		}
		return podStartEnded, string(pod.Status.Phase), pod.Status.Message
	}
	if cs != nil && cs.State.Waiting != nil {
		return podStartPending, cs.State.Waiting.Reason, cs.State.Waiting.Message
	}
	for _, c := range pod.Status.Conditions {
		if c.Status == corev1.ConditionFalse && c.Reason != "" {
			return podStartPending, c.Reason, c.Message
		}
	}
	return podStartPending, pod.Status.Reason, pod.Status.Message
}
