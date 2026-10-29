// resource_graph_fetch.go — resource-graph 빌드에 필요한 K8s 리소스 병렬 fetch (네임스페이스를 고르면 그 네임스페이스마다).
//
// resource_graph.go 에서 분리. 20개 K8s 리스트 호출 (Namespaced 18 + Cluster-scoped 2)
// 을 goroutine fan-out 으로 동시 수행. 첫 에러를 firstErr 로 보존.

package k8s

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// fetchResourceGraphData fetches all Kubernetes resources used in the resource
// graph in parallel goroutines. Returns the first error other than Forbidden.
func (s *Service) fetchResourceGraphData(ctx context.Context, namespaces []string) (*rgResources, error) {
	// One list across the cluster with no namespace chosen, else one per chosen namespace: a namespace-scoped
	// grant reaches its namespaces only, and a large cluster's other namespaces are not read.
	targets := namespaces
	if len(targets) == 0 {
		targets = []string{""}
	}

	var res rgResources
	var mu sync.Mutex
	var wg sync.WaitGroup
	var firstErr error

	// A kind the identity may not list is left out of the graph and named in res.forbidden — with the
	// namespaces when only some of the chosen ones refused it; any other error fails the graph.
	fetch := func(kind string, fn func(ns string) error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var refused []string
			for _, ns := range targets {
				if err := fn(ns); err != nil {
					if apierrors.IsForbidden(err) {
						refused = append(refused, ns)
						continue
					}
					mu.Lock()
					if firstErr == nil {
						firstErr = fmt.Errorf("%s: %w", kind, err)
					}
					mu.Unlock()
					return
				}
			}
			mu.Lock()
			defer mu.Unlock()
			switch {
			case len(refused) == len(targets):
				res.forbidden = append(res.forbidden, kind)
			case len(refused) > 0:
				res.forbidden = append(res.forbidden, kind+" ("+strings.Join(refused, ", ")+")")
			}
		}()
	}
	// cluster-scoped kinds are listed once
	fetchCluster := func(kind string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				defer mu.Unlock()
				if apierrors.IsForbidden(err) {
					res.forbidden = append(res.forbidden, kind)
				} else if firstErr == nil {
					firstErr = fmt.Errorf("%s: %w", kind, err)
				}
			}
		}()
	}

	// --- Namespaced resources ---
	fetch("Pod", func(ns string) error {
		// podListChunk at a time, each page cut to rgPod, so a large cluster is never held whole
		var pods []rgPod
		opts := metav1.ListOptions{Limit: podListChunk}
		for {
			list, err := s.clientsetCtx(ctx).CoreV1().Pods(ns).List(ctx, opts)
			if err != nil {
				return err
			}
			for i := range list.Items {
				pods = append(pods, toRGPod(&list.Items[i]))
			}
			if list.Continue == "" {
				break
			}
			opts.Continue = list.Continue
		}
		mu.Lock()
		res.pods = append(res.pods, pods...)
		mu.Unlock()
		return nil
	})

	fetch("Service", func(ns string) error {
		list, err := s.clientsetCtx(ctx).CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.services = append(res.services, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("ConfigMap", func(ns string) error {
		list, err := s.clientsetCtx(ctx).CoreV1().ConfigMaps(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.configMaps = append(res.configMaps, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("Secret", func(ns string) error {
		list, err := s.clientsetCtx(ctx).CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.secrets = append(res.secrets, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("PersistentVolumeClaim", func(ns string) error {
		list, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumeClaims(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvcs = append(res.pvcs, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("Ingress", func(ns string) error {
		list, err := s.clientsetCtx(ctx).NetworkingV1().Ingresses(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.ingresses = append(res.ingresses, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("RoleBinding", func(ns string) error {
		list, err := s.clientsetCtx(ctx).RbacV1().RoleBindings(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.roleBindings = append(res.roleBindings, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("ServiceAccount", func(ns string) error {
		list, err := s.clientsetCtx(ctx).CoreV1().ServiceAccounts(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.serviceAccounts = append(res.serviceAccounts, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("ReplicaSet", func(ns string) error {
		list, err := s.clientsetCtx(ctx).AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.replicaSets = append(res.replicaSets, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("Deployment", func(ns string) error {
		list, err := s.clientsetCtx(ctx).AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.deployments = append(res.deployments, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("StatefulSet", func(ns string) error {
		list, err := s.clientsetCtx(ctx).AppsV1().StatefulSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.statefulSets = append(res.statefulSets, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("DaemonSet", func(ns string) error {
		list, err := s.clientsetCtx(ctx).AppsV1().DaemonSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.daemonSets = append(res.daemonSets, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("Job", func(ns string) error {
		list, err := s.clientsetCtx(ctx).BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.jobs = append(res.jobs, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("CronJob", func(ns string) error {
		list, err := s.clientsetCtx(ctx).BatchV1().CronJobs(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.cronJobs = append(res.cronJobs, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("HorizontalPodAutoscaler", func(ns string) error {
		list, err := s.clientsetCtx(ctx).AutoscalingV2().HorizontalPodAutoscalers(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.hpas = append(res.hpas, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("NetworkPolicy", func(ns string) error {
		list, err := s.clientsetCtx(ctx).NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.networkPolicies = append(res.networkPolicies, list.Items...)
		mu.Unlock()
		return nil
	})

	fetch("EndpointSlice", func(ns string) error {
		list, err := s.clientsetCtx(ctx).DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.endpointSlices = append(res.endpointSlices, list.Items...)
		mu.Unlock()
		return nil
	})

	// --- Cluster-scoped resources ---
	fetchCluster("PersistentVolume", func() error {
		list, err := s.clientsetCtx(ctx).CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvs = append(res.pvs, list.Items...)
		mu.Unlock()
		return nil
	})

	fetchCluster("StorageClass", func() error {
		list, err := s.clientsetCtx(ctx).StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.storageClasses = append(res.storageClasses, list.Items...)
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
