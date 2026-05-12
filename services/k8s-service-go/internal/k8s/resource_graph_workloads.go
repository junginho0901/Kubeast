// resource_graph_workloads.go — resource-graph 의 workload 노드/엣지 빌더.
//
// resource_graph.go 의 GetResourceGraph 내부에서 분리. Deployments / StatefulSets /
// DaemonSets / ReplicaSets / Jobs / CronJobs / Pods (volume·env mounts 포함) 7개 도메인.
// closure (`inScope`, `addNode`) 는 호출자에서 그대로 전달 받음 — 본문 byte-equal 유지.

package k8s

import "fmt"

// buildWorkloadGraph populates the resource graph with workload-related nodes
// and edges (Deployments / StatefulSets / DaemonSets / ReplicaSets / Jobs /
// CronJobs / Pods plus Pod's volume/env references to ConfigMap, Secret, PVC).
//
// nodeMap is mutated in-place. The updated edges slice is returned (append
// may reallocate, so the caller must reassign).
func buildWorkloadGraph(
	res *rgResources,
	nodeMap map[string]rgNode,
	addNode func(rgNode),
	edges []rgEdge,
	inScope func(string) bool,
) []rgEdge {
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

	return edges
}
