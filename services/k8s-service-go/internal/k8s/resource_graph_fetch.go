// resource_graph_fetch.go — resource-graph 빌드에 필요한 K8s 리소스 병렬 fetch.
//
// resource_graph.go 에서 분리. 20개 K8s 리스트 호출 (Namespaced 18 + Cluster-scoped 2)
// 을 goroutine fan-out 으로 동시 수행. 첫 에러를 firstErr 로 보존.

package k8s

import (
	"context"
	"fmt"
	"sort"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// fetchResourceGraphData fetches all Kubernetes resources used in the resource
// graph in parallel goroutines. Returns the first error other than Forbidden.
func (s *Service) fetchResourceGraphData(ctx context.Context, namespaces []string) (*rgResources, error) {
	// Determine namespace for queries ("" means all namespaces)
	ns := ""
	if len(namespaces) == 1 {
		ns = namespaces[0]
	}

	var res rgResources
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error

	// A kind the identity may not list is left out of the graph and named in
	// res.forbidden; any other error fails the graph.
	fetch := func(kind string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				if apierrors.IsForbidden(err) {
					res.forbidden = append(res.forbidden, kind)
				} else if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", kind, err)
				}
				mu.Unlock()
			}
		}()
	}

	// --- Namespaced resources ---
	fetch("Pod", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pods = list.Items
		mu.Unlock()
		return nil
	})

	fetch("Service", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.services = list.Items
		mu.Unlock()
		return nil
	})

	fetch("ConfigMap", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().ConfigMaps(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.configMaps = list.Items
		mu.Unlock()
		return nil
	})

	fetch("Secret", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.secrets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("PersistentVolumeClaim", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvcs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("Ingress", func() error {
		list, err := s.clientsetCtx(ctx).NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.ingresses = list.Items
		mu.Unlock()
		return nil
	})

	fetch("RoleBinding", func() error {
		list, err := s.clientsetCtx(ctx).RbacV1().RoleBindings(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.roleBindings = list.Items
		mu.Unlock()
		return nil
	})

	fetch("ServiceAccount", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().ServiceAccounts(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.serviceAccounts = list.Items
		mu.Unlock()
		return nil
	})

	fetch("ReplicaSet", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.replicaSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("Deployment", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.deployments = list.Items
		mu.Unlock()
		return nil
	})

	fetch("StatefulSet", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().StatefulSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.statefulSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("DaemonSet", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().DaemonSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.daemonSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("Job", func() error {
		list, err := s.clientsetCtx(ctx).BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.jobs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("CronJob", func() error {
		list, err := s.clientsetCtx(ctx).BatchV1().CronJobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.cronJobs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("HorizontalPodAutoscaler", func() error {
		list, err := s.clientsetCtx(ctx).AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.hpas = list.Items
		mu.Unlock()
		return nil
	})

	fetch("NetworkPolicy", func() error {
		list, err := s.clientsetCtx(ctx).NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.networkPolicies = list.Items
		mu.Unlock()
		return nil
	})

	fetch("EndpointSlice", func() error {
		list, err := s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.endpointSlices = list.Items
		mu.Unlock()
		return nil
	})

	// --- Cluster-scoped resources ---
	fetch("PersistentVolume", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("StorageClass", func() error {
		list, err := s.clientsetCtx(ctx).StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.storageClasses = list.Items
		mu.Unlock()
		return nil
	})

	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	sort.Strings(res.forbidden)
	return &res, nil
}
