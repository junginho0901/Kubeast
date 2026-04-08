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
		}
		mu.Lock()
		res.hpas = list.Items
		mu.Unlock()
		return nil
	})

	fetch("networkpolicies", func() error {
		list, err := s.clientset.NetworkingV1().NetworkPolicies(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.networkPolicies = list.Items
		mu.Unlock()
		return nil
	})

	fetch("endpointslices", func() error {
		list, err := s.clientset.DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.endpointSlices = list.Items
		mu.Unlock()
		return nil
	})

	fetch("endpoints", func() error {
		list, err := s.clientset.CoreV1().Endpoints(ns).List(ctx, metav1.ListOptions{})
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
		list, err := s.clientset.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
		if err != nil {
			return err
		}
		mu.Lock()
		res.pvs = list.Items
		mu.Unlock()
		return nil
	})

	fetch("storageclasses", func() error {
		list, err := s.clientset.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
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

	// Filter by namespaces if multiple specified
	nsFilter := make(map[string]bool)
	if len(namespaces) > 1 {
		for _, n := range namespaces {
			nsFilter[n] = true
		}
	}
	inScope := func(namespace string) bool {
		if len(nsFilter) == 0 {
			return true
		}
		return nsFilter[namespace]
	}

	nodeMap := make(map[string]rgNode)
	edges := make([]rgEdge, 0, 512)

	addNode := func(n rgNode) {
		if _, exists := nodeMap[n.ID]; !exists {
			nodeMap[n.ID] = n
		}
	}

	// ========== BUILD NODES & EDGES ==========

	// --- Deployments ---
	for i := range res.deployments {
		d := &res.deployments[i]
		if !inScope(d.Namespace) {
			continue
		}
		ready := fmt.Sprintf("%d/%d", d.Status.ReadyReplicas, *d.Spec.Replicas)
		status := "Running"
		if d.Status.ReadyReplicas < *d.Spec.Replicas {
			status = "Progressing"
		}
		addNode(rgNode{
			ID: rgNodeID("Deployment", d.Namespace, d.Name), Kind: "Deployment",
			Name: d.Name, Namespace: d.Namespace, Status: status, Ready: ready,
			Labels: d.Labels, InstanceLabel: d.Labels["app.kubernetes.io/instance"],
		})
	}

	// --- StatefulSets ---
	for i := range res.statefulSets {
		ss := &res.statefulSets[i]
		if !inScope(ss.Namespace) {
			continue
		}
		replicas := int32(1)
		if ss.Spec.Replicas != nil {
			replicas = *ss.Spec.Replicas
		}
		ready := fmt.Sprintf("%d/%d", ss.Status.ReadyReplicas, replicas)
		addNode(rgNode{
			ID: rgNodeID("StatefulSet", ss.Namespace, ss.Name), Kind: "StatefulSet",
			Name: ss.Name, Namespace: ss.Namespace, Status: "Running", Ready: ready,
			Labels: ss.Labels, InstanceLabel: ss.Labels["app.kubernetes.io/instance"],
		})
	}

	// --- DaemonSets ---
	for i := range res.daemonSets {
		ds := &res.daemonSets[i]
		if !inScope(ds.Namespace) {
			continue
		}
		ready := fmt.Sprintf("%d/%d", ds.Status.NumberReady, ds.Status.DesiredNumberScheduled)
		addNode(rgNode{
			ID: rgNodeID("DaemonSet", ds.Namespace, ds.Name), Kind: "DaemonSet",
			Name: ds.Name, Namespace: ds.Namespace, Status: "Running", Ready: ready,
			Labels: ds.Labels, InstanceLabel: ds.Labels["app.kubernetes.io/instance"],
		})
	}

	// --- ReplicaSets ---
	for i := range res.replicaSets {
		rs := &res.replicaSets[i]
		if !inScope(rs.Namespace) {
			continue
		}
		replicas := int32(1)
		if rs.Spec.Replicas != nil {
			replicas = *rs.Spec.Replicas
		}
		// Skip RS with 0 replicas (old revisions)
		if replicas == 0 && rs.Status.Replicas == 0 {
			continue
		}
		ready := fmt.Sprintf("%d/%d", rs.Status.ReadyReplicas, replicas)
		rsID := rgNodeID("ReplicaSet", rs.Namespace, rs.Name)
		ownerKind := ""
		addNode(rgNode{
			ID: rsID, Kind: "ReplicaSet",
			Name: rs.Name, Namespace: rs.Namespace, Status: "Running", Ready: ready,
			Labels: rs.Labels,
		})
		for _, ref := range rs.OwnerReferences {
			ownerKind = ref.Kind
			ownerID := rgNodeID(ref.Kind, rs.Namespace, ref.Name)
			edges = append(edges, rgEdge{Source: ownerID, Target: rsID, Type: RGEdgeOwns})
		}
		if n, ok := nodeMap[rsID]; ok && ownerKind != "" {
			n.OwnerKind = ownerKind
			nodeMap[rsID] = n
		}
	}

	// --- Jobs ---
	for i := range res.jobs {
		job := &res.jobs[i]
		if !inScope(job.Namespace) {
			continue
		}
		status := "Running"
		if job.Status.Succeeded > 0 {
			status = "Succeeded"
		} else if job.Status.Failed > 0 {
			status = "Failed"
		}
		jobID := rgNodeID("Job", job.Namespace, job.Name)
		addNode(rgNode{
			ID: jobID, Kind: "Job",
			Name: job.Name, Namespace: job.Namespace, Status: status,
			Labels: job.Labels,
		})
		for _, ref := range job.OwnerReferences {
			if ref.Kind == "CronJob" {
				ownerID := rgNodeID("CronJob", job.Namespace, ref.Name)
				edges = append(edges, rgEdge{Source: ownerID, Target: jobID, Type: RGEdgeOwns})
			}
		}
	}

	// --- CronJobs ---
	for i := range res.cronJobs {
		cj := &res.cronJobs[i]
		if !inScope(cj.Namespace) {
			continue
		}
		addNode(rgNode{
			ID: rgNodeID("CronJob", cj.Namespace, cj.Name), Kind: "CronJob",
			Name: cj.Name, Namespace: cj.Namespace, Status: "Active",
			Labels: cj.Labels,
		})
	}

	// --- Pods ---
	for i := range res.pods {
		pod := &res.pods[i]
		if !inScope(pod.Namespace) {
			continue
		}
		status := string(pod.Status.Phase)
		ready := podReadyCount(pod)
		podID := rgNodeID("Pod", pod.Namespace, pod.Name)

		ownerKind := ""
		if len(pod.OwnerReferences) > 0 {
			ownerKind = pod.OwnerReferences[0].Kind
		}

		addNode(rgNode{
			ID: podID, Kind: "Pod",
			Name: pod.Name, Namespace: pod.Namespace,
			Status: status, Ready: ready, Labels: pod.Labels,
			NodeName: pod.Spec.NodeName, OwnerKind: ownerKind,
			InstanceLabel: pod.Labels["app.kubernetes.io/instance"],
		})

		// ownerReferences → owns edges
		for _, ref := range pod.OwnerReferences {
			ownerID := rgNodeID(ref.Kind, pod.Namespace, ref.Name)
			edges = append(edges, rgEdge{Source: ownerID, Target: podID, Type: RGEdgeOwns})
		}

		// volume mounts → ConfigMap, Secret, PVC
		for _, vol := range pod.Spec.Volumes {
			if vol.ConfigMap != nil {
				cmID := rgNodeID("ConfigMap", pod.Namespace, vol.ConfigMap.Name)
				addNode(rgNode{ID: cmID, Kind: "ConfigMap", Name: vol.ConfigMap.Name, Namespace: pod.Namespace, Status: "Active"})
				edges = append(edges, rgEdge{Source: podID, Target: cmID, Type: RGEdgeMounts})
			}
			if vol.Secret != nil {
				sID := rgNodeID("Secret", pod.Namespace, vol.Secret.SecretName)
				addNode(rgNode{ID: sID, Kind: "Secret", Name: vol.Secret.SecretName, Namespace: pod.Namespace, Status: "Active"})
				edges = append(edges, rgEdge{Source: podID, Target: sID, Type: RGEdgeMounts})
			}
			if vol.PersistentVolumeClaim != nil {
				pvcID := rgNodeID("PersistentVolumeClaim", pod.Namespace, vol.PersistentVolumeClaim.ClaimName)
				edges = append(edges, rgEdge{Source: podID, Target: pvcID, Type: RGEdgeMounts})
			}
		}

		// env references → ConfigMap, Secret
		for _, c := range pod.Spec.Containers {
			for _, ef := range c.EnvFrom {
				if ef.ConfigMapRef != nil {
					cmID := rgNodeID("ConfigMap", pod.Namespace, ef.ConfigMapRef.Name)
					addNode(rgNode{ID: cmID, Kind: "ConfigMap", Name: ef.ConfigMapRef.Name, Namespace: pod.Namespace, Status: "Active"})
					edges = append(edges, rgEdge{Source: podID, Target: cmID, Type: RGEdgeMounts})
				}
				if ef.SecretRef != nil {
					sID := rgNodeID("Secret", pod.Namespace, ef.SecretRef.Name)
					addNode(rgNode{ID: sID, Kind: "Secret", Name: ef.SecretRef.Name, Namespace: pod.Namespace, Status: "Active"})
					edges = append(edges, rgEdge{Source: podID, Target: sID, Type: RGEdgeMounts})
				}
			}
			for _, env := range c.Env {
				if env.ValueFrom == nil {
					continue
				}
				if env.ValueFrom.ConfigMapKeyRef != nil {
					cmID := rgNodeID("ConfigMap", pod.Namespace, env.ValueFrom.ConfigMapKeyRef.Name)
					addNode(rgNode{ID: cmID, Kind: "ConfigMap", Name: env.ValueFrom.ConfigMapKeyRef.Name, Namespace: pod.Namespace, Status: "Active"})
					edges = append(edges, rgEdge{Source: podID, Target: cmID, Type: RGEdgeMounts})
				}
				if env.ValueFrom.SecretKeyRef != nil {
					sID := rgNodeID("Secret", pod.Namespace, env.ValueFrom.SecretKeyRef.Name)
					addNode(rgNode{ID: sID, Kind: "Secret", Name: env.ValueFrom.SecretKeyRef.Name, Namespace: pod.Namespace, Status: "Active"})
					edges = append(edges, rgEdge{Source: podID, Target: sID, Type: RGEdgeMounts})
				}
			}
		}
	}

	// --- Services → selector matching to Pods ---
	for i := range res.services {
		svc := &res.services[i]
		if !inScope(svc.Namespace) {
			continue
		}
		svcID := rgNodeID("Service", svc.Namespace, svc.Name)
		svcType := string(svc.Spec.Type)
		addNode(rgNode{
			ID: svcID, Kind: "Service",
			Name: svc.Name, Namespace: svc.Namespace, Status: svcType,
			Labels: svc.Labels,
		})

		if len(svc.Spec.Selector) == 0 {
			continue
		}
		for j := range res.pods {
			pod := &res.pods[j]
			if pod.Namespace != svc.Namespace {
				continue
			}
			if selectorMatches(svc.Spec.Selector, pod.Labels) {
				edges = append(edges, rgEdge{
					Source: svcID,
					Target: rgNodeID("Pod", pod.Namespace, pod.Name),
					Type:   RGEdgeSelects,
				})
			}
		}
	}

	// --- ConfigMaps (ensure nodes exist) ---
	for i := range res.configMaps {
		cm := &res.configMaps[i]
		if !inScope(cm.Namespace) {
			continue
		}
		addNode(rgNode{
			ID: rgNodeID("ConfigMap", cm.Namespace, cm.Name), Kind: "ConfigMap",
			Name: cm.Name, Namespace: cm.Namespace, Status: "Active",
		})
	}

	// --- Secrets (ensure nodes exist) ---
	for i := range res.secrets {
		sec := &res.secrets[i]
		if !inScope(sec.Namespace) {
			continue
		}
		addNode(rgNode{
			ID: rgNodeID("Secret", sec.Namespace, sec.Name), Kind: "Secret",
			Name: sec.Name, Namespace: sec.Namespace, Status: "Active",
		})
	}

	// --- PVCs ---
	for i := range res.pvcs {
		pvc := &res.pvcs[i]
		if !inScope(pvc.Namespace) {
			continue
		}
		pvcID := rgNodeID("PersistentVolumeClaim", pvc.Namespace, pvc.Name)
		addNode(rgNode{
			ID: pvcID, Kind: "PersistentVolumeClaim",
			Name: pvc.Name, Namespace: pvc.Namespace, Status: string(pvc.Status.Phase),
		})
		// PVC → PV (bound_to)
		if pvc.Spec.VolumeName != "" {
			pvID := rgNodeID("PersistentVolume", "", pvc.Spec.VolumeName)
			edges = append(edges, rgEdge{Source: pvcID, Target: pvID, Type: RGEdgeBoundTo})
		}
	}

	// --- PVs (cluster-scoped) ---
	for i := range res.pvs {
		pv := &res.pvs[i]
		pvID := rgNodeID("PersistentVolume", "", pv.Name)
		addNode(rgNode{
			ID: pvID, Kind: "PersistentVolume",
			Name: pv.Name, Status: string(pv.Status.Phase),
		})
		// PV → StorageClass (provisions)
		if pv.Spec.StorageClassName != "" {
			scID := rgNodeID("StorageClass", "", pv.Spec.StorageClassName)
			edges = append(edges, rgEdge{Source: scID, Target: pvID, Type: RGEdgeProvisions})
		}
	}

	// --- StorageClasses (cluster-scoped) ---
	for i := range res.storageClasses {
		sc := &res.storageClasses[i]
		addNode(rgNode{
			ID: rgNodeID("StorageClass", "", sc.Name), Kind: "StorageClass",
			Name: sc.Name, Status: sc.Provisioner,
		})
	}

	// --- Ingresses → Service ---
	for i := range res.ingresses {
		ing := &res.ingresses[i]
		if !inScope(ing.Namespace) {
			continue
		}
		ingID := rgNodeID("Ingress", ing.Namespace, ing.Name)
		addNode(rgNode{
			ID: ingID, Kind: "Ingress",
			Name: ing.Name, Namespace: ing.Namespace, Status: "Active",
			Labels: ing.Labels,
		})
		for _, rule := range ing.Spec.Rules {
			if rule.HTTP == nil {
				continue
			}
			for _, path := range rule.HTTP.Paths {
				if path.Backend.Service != nil {
					svcID := rgNodeID("Service", ing.Namespace, path.Backend.Service.Name)
					edges = append(edges, rgEdge{Source: ingID, Target: svcID, Type: RGEdgeRoutes})
				}
			}
		}
		if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
			svcID := rgNodeID("Service", ing.Namespace, ing.Spec.DefaultBackend.Service.Name)
			edges = append(edges, rgEdge{Source: ingID, Target: svcID, Type: RGEdgeRoutes})
		}
	}

	// --- HPA → Deployment / StatefulSet ---
	for i := range res.hpas {
		hpa := &res.hpas[i]
		if !inScope(hpa.Namespace) {
			continue
		}
		hpaID := rgNodeID("HorizontalPodAutoscaler", hpa.Namespace, hpa.Name)
		ready := fmt.Sprintf("%d/%d", hpa.Status.CurrentReplicas, hpa.Status.DesiredReplicas)
		addNode(rgNode{
			ID: hpaID, Kind: "HorizontalPodAutoscaler",
			Name: hpa.Name, Namespace: hpa.Namespace, Status: "Active", Ready: ready,
		})
		targetKind := hpa.Spec.ScaleTargetRef.Kind
		targetName := hpa.Spec.ScaleTargetRef.Name
		targetID := rgNodeID(targetKind, hpa.Namespace, targetName)
		edges = append(edges, rgEdge{Source: hpaID, Target: targetID, Type: RGEdgeHPATargets})
	}

	// --- NetworkPolicy → Pod (selector matching) ---
	for i := range res.networkPolicies {
		np := &res.networkPolicies[i]
		if !inScope(np.Namespace) {
			continue
		}
		npID := rgNodeID("NetworkPolicy", np.Namespace, np.Name)
		addNode(rgNode{
			ID: npID, Kind: "NetworkPolicy",
			Name: np.Name, Namespace: np.Namespace, Status: "Active",
		})
		if np.Spec.PodSelector.MatchLabels != nil {
			for j := range res.pods {
				pod := &res.pods[j]
				if pod.Namespace != np.Namespace {
					continue
				}
				if selectorMatchesStr(np.Spec.PodSelector.MatchLabels, pod.Labels) {
					edges = append(edges, rgEdge{Source: npID, Target: rgNodeID("Pod", pod.Namespace, pod.Name), Type: RGEdgeNetworkPolicy})
				}
			}
		}
	}

	// --- EndpointSlices → Service ---
	for i := range res.endpointSlices {
		eps := &res.endpointSlices[i]
		if !inScope(eps.Namespace) {
			continue
		}
		// EndpointSlice owner is typically the Service
