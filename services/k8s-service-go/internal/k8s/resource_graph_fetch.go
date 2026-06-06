// resource_graph_fetch.go — resource-graph 빌드에 필요한 K8s 리소스 병렬 fetch.
//
// resource_graph.go 에서 분리. 20개 K8s 리스트 호출 (Namespaced 18 + Cluster-scoped 2)
// 을 goroutine fan-out 으로 동시 수행. 첫 에러를 firstErr 로 보존.

package k8s

import (
	"context"
	"fmt"
	"sync"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// fetchResourceGraphData fetches all Kubernetes resources used in the resource
// graph in parallel goroutines. Returns the first error encountered (if any).
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
		list, err := s.clientsetCtx(ctx).CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pods = list.Items
		mu.Unlock()
		return nil
	})

	fetch("services", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.services = list.Items
		mu.Unlock()
		return nil
	})

	fetch("configmaps", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().ConfigMaps(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.configMaps = list.Items
		mu.Unlock()
		return nil
	})

	fetch("secrets", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.secrets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("pvcs", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvcs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("ingresses", func() error {
		list, err := s.clientsetCtx(ctx).NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.ingresses = list.Items
		mu.Unlock()
		return nil
	})

	fetch("rolebindings", func() error {
		list, err := s.clientsetCtx(ctx).RbacV1().RoleBindings(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.roleBindings = list.Items
		mu.Unlock()
		return nil
	})

	fetch("serviceaccounts", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().ServiceAccounts(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.serviceAccounts = list.Items
		mu.Unlock()
		return nil
	})

	fetch("replicasets", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.replicaSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("deployments", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.deployments = list.Items
		mu.Unlock()
		return nil
	})

	fetch("statefulsets", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().StatefulSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.statefulSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("daemonsets", func() error {
		list, err := s.clientsetCtx(ctx).AppsV1().DaemonSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.daemonSets = list.Items
		mu.Unlock()
		return nil
	})

	fetch("jobs", func() error {
		list, err := s.clientsetCtx(ctx).BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.jobs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("cronjobs", func() error {
		list, err := s.clientsetCtx(ctx).BatchV1().CronJobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.cronJobs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("hpas", func() error {
		list, err := s.clientsetCtx(ctx).AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.hpas = list.Items
		mu.Unlock()
		return nil
	})

	fetch("networkpolicies", func() error {
		list, err := s.clientsetCtx(ctx).NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.networkPolicies = list.Items
		mu.Unlock()
		return nil
	})

	fetch("endpointslices", func() error {
		list, err := s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.endpointSlices = list.Items
		mu.Unlock()
		return nil
	})

	fetch("endpoints", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().Endpoints(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.endpoints = list.Items
		mu.Unlock()
		return nil
	})

	// --- Cluster-scoped resources ---
	fetch("pvs", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("storageclasses", func() error {
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
	return &res, nil
}
