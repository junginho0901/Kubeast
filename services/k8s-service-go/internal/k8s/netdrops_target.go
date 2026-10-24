package k8s

import (
	"context"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
)

// NetdropsTarget reads, as the signed-in user, what the drop metric knows of a target: its workload as
// the Hubble agent names it (the Deployment of a ReplicaSet's pods, the CronJob of a Job's) and, with
// wantPods, its current pods (at most netdrops.MaxPods; truncated says there were more).
func (s *Service) NetdropsTarget(ctx context.Context, namespace, kind, name string, wantPods bool) (*netdrops.Workload, []string, bool, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, nil, false, ErrNoUser
	}
	return netdropsTarget(ctx, cs, namespace, kind, name, wantPods)
}

func netdropsTarget(ctx context.Context, cs kubernetes.Interface, namespace, kind, name string, wantPods bool) (*netdrops.Workload, []string, bool, error) {
	get := metav1.GetOptions{}
	var w *netdrops.Workload
	switch kind {
	case "":
		return nil, nil, false, nil
	case "Pod":
		p, err := cs.CoreV1().Pods(namespace).Get(ctx, name, get)
		if err != nil {
			return nil, nil, false, err
		}
		if ref := metav1.GetControllerOf(p); ref != nil {
			w, err = ownerWorkload(ctx, cs, namespace, ref.Kind, ref.Name)
			if err != nil {
				return nil, nil, false, err
			}
		}
		return w, []string{name}, false, nil
	case "ReplicaSet", "Job":
		var err error
		if w, err = ownerWorkload(ctx, cs, namespace, kind, name); err != nil {
			return nil, nil, false, err
		}
	default:
		w = &netdrops.Workload{Kind: kind, Name: name}
	}
	if !wantPods {
		return w, nil, false, nil
	}
	r := &netpolReader{cs: cs}
	labels, _, sel, err := r.template(ctx, NetpolRef{Kind: strings.ToLower(kind), Namespace: namespace, Name: name})
	if err != nil {
		return nil, nil, false, err
	}
	if sel == nil { // a CronJob: its pods carry the template's labels
		if len(labels) == 0 {
			return w, nil, false, nil
		}
		sel = &metav1.LabelSelector{MatchLabels: labels}
	}
	pods, truncated, err := r.pods(ctx, namespace, sel)
	if err != nil {
		return nil, nil, false, err
	}
	names := make([]string, 0, len(pods))
	for _, p := range pods {
		names = append(names, p.Name)
	}
	return w, names, truncated, nil
}

// ownerWorkload names the workload of a ReplicaSet's or Job's pods: their controller's owner when it is a
// Deployment or CronJob, else the object itself; any other controller as it is.
func ownerWorkload(ctx context.Context, cs kubernetes.Interface, namespace, kind, name string) (*netdrops.Workload, error) {
	get := metav1.GetOptions{}
	switch kind {
	case "ReplicaSet":
		rs, err := cs.AppsV1().ReplicaSets(namespace).Get(ctx, name, get)
		if err != nil {
			return nil, err
		}
		if ref := metav1.GetControllerOf(rs); ref != nil && ref.Kind == "Deployment" {
			return &netdrops.Workload{Kind: "Deployment", Name: ref.Name}, nil
		}
	case "Job":
		job, err := cs.BatchV1().Jobs(namespace).Get(ctx, name, get)
		if err != nil {
			return nil, err
		}
		if ref := metav1.GetControllerOf(job); ref != nil && ref.Kind == "CronJob" {
			return &netdrops.Workload{Kind: "CronJob", Name: ref.Name}, nil
		}
	}
	return &netdrops.Workload{Kind: kind, Name: name}, nil
}
