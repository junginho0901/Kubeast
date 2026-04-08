package k8s

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Resource Graph edge types
const (
	RGEdgeOwns          = "owns"
	RGEdgeSelects       = "selects"
	RGEdgeMounts        = "mounts"
	RGEdgeRoutes        = "routes"
	RGEdgeBinds         = "binds"
	RGEdgeBoundTo       = "bound_to"
	RGEdgeProvisions    = "provisions"
	RGEdgeHPATargets    = "hpa_targets"
	RGEdgeNetworkPolicy = "network_policy"
	RGEdgeEndpointOf    = "endpoint_of"
	RGEdgeSAUsedBy      = "sa_used_by"
)

// rgNode represents a node in the resource graph.
type rgNode struct {
	ID            string            `json:"id"`
	Kind          string            `json:"kind"`
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	Status        string            `json:"status"`
	Ready         string            `json:"ready,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
	NodeName      string            `json:"nodeName,omitempty"`
	OwnerKind     string            `json:"ownerKind,omitempty"`
	InstanceLabel string            `json:"instanceLabel,omitempty"`
}

// rgEdge represents an edge in the resource graph.
type rgEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}

func rgNodeID(kind, namespace, name string) string {
	if namespace == "" {
		return fmt.Sprintf("%s//%s", kind, name)
	}
	return fmt.Sprintf("%s/%s/%s", kind, namespace, name)
}

// rgResources holds all fetched Kubernetes resources.
type rgResources struct {
	pods            []corev1.Pod
	services        []corev1.Service
	configMaps      []corev1.ConfigMap
	secrets         []corev1.Secret
	pvcs            []corev1.PersistentVolumeClaim
	pvs             []corev1.PersistentVolume
	storageClasses  []storagev1.StorageClass
	ingresses       []networkingv1.Ingress
	roleBindings    []rbacv1.RoleBinding
	serviceAccounts []corev1.ServiceAccount
	replicaSets     []appsv1.ReplicaSet
	deployments     []appsv1.Deployment
	statefulSets    []appsv1.StatefulSet
	daemonSets      []appsv1.DaemonSet
	jobs            []batchv1.Job
	cronJobs        []batchv1.CronJob
	hpas            []autoscalingv2.HorizontalPodAutoscaler
	networkPolicies []networkingv1.NetworkPolicy
	endpointSlices  []discoveryv1.EndpointSlice
	endpoints       []corev1.Endpoints
}

// GetResourceGraph returns a comprehensive resource graph for given namespaces.
// If namespaces is empty, it fetches across all namespaces.
func (s *Service) GetResourceGraph(ctx context.Context, namespaces []string) (map[string]interface{}, error) {
	cacheKey := fmt.Sprintf("resource-graph|%s", strings.Join(namespaces, ","))
	var cached map[string]interface{}
	if s.cache.Get(ctx, cacheKey, &cached) {
		return cached, nil
	}

	// Determine namespace for queries ("" means all namespaces)
	ns := ""
	if len(namespaces) == 1 {
		ns = namespaces[0]
	}

	var res rgResources
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error

	fetch := func(name string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", name, err)
				}
				mu.Unlock()
			}
		}()
	}

	// --- Namespaced resources ---
	fetch("pods", func() error {
		list, err := s.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pods = list.Items
		mu.Unlock()
		return nil
	})

	fetch("services", func() error {
		list, err := s.clientset.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.services = list.Items
		mu.Unlock()
		return nil
	})

	fetch("configmaps", func() error {
		list, err := s.clientset.CoreV1().ConfigMaps(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.configMaps = list.Items
		mu.Unlock()
		return nil
	})

	fetch("secrets", func() error {
		list, err := s.clientset.CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.secrets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("pvcs", func() error {
		list, err := s.clientset.CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvcs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("ingresses", func() error {
		list, err := s.clientset.NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.ingresses = list.Items
		mu.Unlock()
		return nil
	})

	fetch("rolebindings", func() error {
		list, err := s.clientset.RbacV1().RoleBindings(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.roleBindings = list.Items
		mu.Unlock()
		return nil
	})

	fetch("serviceaccounts", func() error {
		list, err := s.clientset.CoreV1().ServiceAccounts(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.serviceAccounts = list.Items
		mu.Unlock()
		return nil
	})

	fetch("replicasets", func() error {
		list, err := s.clientset.AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.replicaSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("deployments", func() error {
		list, err := s.clientset.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.deployments = list.Items
		mu.Unlock()
		return nil
	})

	fetch("statefulsets", func() error {
		list, err := s.clientset.AppsV1().StatefulSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.statefulSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("daemonsets", func() error {
		list, err := s.clientset.AppsV1().DaemonSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.daemonSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("jobs", func() error {
		list, err := s.clientset.BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.jobs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("cronjobs", func() error {
		list, err := s.clientset.BatchV1().CronJobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.cronJobs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("hpas", func() error {
		list, err := s.clientset.AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
