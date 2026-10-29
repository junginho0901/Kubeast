package k8s

import (
	"context"
	"regexp"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
)

// NetflowsWorkloads lists a namespace's pods the signed-in user may see — from the pod rows (callerPodRows: the
// overview informers, or listed as the user until they can serve) — each with its workload as the Hubble agent
// names it (agentWorkload), keyed by the pod's name and by <generateName>* (Calico's name for the pods of one
// GenerateName). Pods without one are left out; there is no cap on the pods.
func (s *Service) NetflowsWorkloads(ctx context.Context, namespace string) (map[string]netflows.Workload, error) {
	set, err := s.callerPodRows(ctx, namespace, "")
	if err != nil {
		return nil, err
	}
	return netflowsWorkloadsOf(set.rows), nil
}

// netflowsWorkloads lists the namespace's pods as the client's identity, 500 at a time, into the same map.
func netflowsWorkloads(ctx context.Context, cs kubernetes.Interface, namespace string) (map[string]netflows.Workload, error) {
	rows, err := listPodRows(ctx, cs.CoreV1(), []string{namespace})
	if err != nil {
		return map[string]netflows.Workload{}, err
	}
	return netflowsWorkloadsOf(rows), nil
}

func netflowsWorkloadsOf(rows []*podRow) map[string]netflows.Workload {
	out := map[string]netflows.Workload{}
	for _, r := range rows {
		if r.workloadKind == "" {
			continue
		}
		w := netflows.Workload{Kind: r.workloadKind, Name: r.workloadName}
		out[r.name] = w
		out[r.generateName+"*"] = w
	}
	return out
}

// NetflowsPodSet reads a pod as the signed-in user and names its set as Calico does: <generateName>*, or the
// pod's own name.
func (s *Service) NetflowsPodSet(ctx context.Context, namespace, pod string) (string, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return "", ErrNoUser
	}
	return netflowsPodSet(ctx, cs, namespace, pod)
}

func netflowsPodSet(ctx context.Context, cs kubernetes.Interface, namespace, pod string) (string, error) {
	p, err := cs.CoreV1().Pods(namespace).Get(ctx, pod, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	if p.GenerateName == "" {
		return p.Name, nil
	}
	return p.GenerateName + "*", nil
}

// NetflowsServiceIPs lists the cluster IPs of a namespace's Services, each with its Service's name, as the signed-in user.
func (s *Service) NetflowsServiceIPs(ctx context.Context, namespace string) (map[string]string, error) {
	cs := s.clientsetCtx(ctx)
	if cs == nil {
		return nil, ErrNoUser
	}
	return netflowsServiceIPs(ctx, cs, namespace)
}

func netflowsServiceIPs(ctx context.Context, cs kubernetes.Interface, namespace string) (map[string]string, error) {
	list, err := cs.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, svc := range list.Items {
		for _, ip := range append([]string{svc.Spec.ClusterIP}, svc.Spec.ClusterIPs...) {
			if ip != "" && ip != corev1.ClusterIPNone {
				out[ip] = svc.Name
			}
		}
	}
	return out, nil
}

var cronJobName = regexp.MustCompile(`(.+)-\d{8,10}$`)

// agentWorkload names a pod's workload the way the Hubble agent does (Cilium v1.20.4
// pkg/k8s/utils/workload.go GetWorkloadMetaFromPod): the controller of a generated pod, the Deployment of a
// ReplicaSet whose name ends in the pod's pod-template-hash, the CronJob of a Job named <name>-<8 to 10 digits>.
func agentWorkload(p *corev1.Pod) (netflows.Workload, bool) {
	if p.GenerateName == "" {
		return netflows.Workload{}, false
	}
	ref := metav1.GetControllerOf(p)
	if ref == nil {
		return netflows.Workload{}, false
	}
	w := netflows.Workload{Kind: ref.Kind, Name: ref.Name}
	hash := p.Labels["pod-template-hash"]
	switch {
	case ref.Kind == "ReplicaSet" && hash != "" && strings.HasSuffix(ref.Name, hash):
		w = netflows.Workload{Kind: "Deployment", Name: strings.TrimSuffix(ref.Name, "-"+hash)}
	case ref.Kind == "ReplicationController" && p.Labels["deploymentconfig"] != "":
		w = netflows.Workload{Kind: "DeploymentConfig", Name: p.Labels["deploymentconfig"]}
	case ref.Kind == "Job":
		if m := cronJobName.FindStringSubmatch(ref.Name); len(m) == 2 {
			w = netflows.Workload{Kind: "CronJob", Name: m[1]}
		}
	}
	return w, true
}
