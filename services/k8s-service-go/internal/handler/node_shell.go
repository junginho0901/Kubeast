package handler

import (
	"context"
	"fmt"
	"strings"

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
