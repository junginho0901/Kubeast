// resource_graph_storage_rbac.go — resource-graph 의 storage 및 RBAC 노드·엣지 빌더.
//
// resource_graph.go 의 GetResourceGraph 내부에서 분리. PVCs / PVs / StorageClasses
// + RoleBindings / ServiceAccounts / ServiceAccount→Deployment·DaemonSet edges
// 6 도메인. closure (`inScope`, `addNode`) 는 호출자에서 그대로 전달 받음 —
// 본문 byte-equal 유지. SA→Deployment·DaemonSet 엣지는 nodeMap[saID] 존재 시에만
// 추가되므로 RoleBindings/ServiceAccounts 처리 후 마지막에 수행.

package k8s

// buildStorageRBACGraph populates the resource graph with storage nodes/edges
// (PersistentVolumeClaims, PersistentVolumes, StorageClasses) and RBAC
// nodes/edges (RoleBindings, ServiceAccounts and SA→Deployment/DaemonSet
// usage edges).
//
// nodeMap is mutated in-place. The updated edges slice is returned (append
// may reallocate, so the caller must reassign).
func buildStorageRBACGraph(
	res *rgResources,
	nodeMap map[string]rgNode,
	addNode func(rgNode),
	edges []rgEdge,
	inScope func(string) bool,
) []rgEdge {
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

	// --- RoleBindings → Role/ClusterRole, ServiceAccount ---
	for i := range res.roleBindings {
		rb := &res.roleBindings[i]
		if !inScope(rb.Namespace) {
			continue
		}
		rbID := rgNodeID("RoleBinding", rb.Namespace, rb.Name)
		addNode(rgNode{
			ID: rbID, Kind: "RoleBinding",
			Name: rb.Name, Namespace: rb.Namespace, Status: "Active",
		})

		roleKind := rb.RoleRef.Kind
		roleName := rb.RoleRef.Name
		roleNS := rb.Namespace
		if roleKind == "ClusterRole" {
			roleNS = ""
		}
		roleID := rgNodeID(roleKind, roleNS, roleName)
		addNode(rgNode{
			ID: roleID, Kind: roleKind, Name: roleName, Namespace: roleNS, Status: "Active",
		})
		edges = append(edges, rgEdge{Source: rbID, Target: roleID, Type: RGEdgeBinds})

		for _, subj := range rb.Subjects {
			if subj.Kind == "ServiceAccount" {
				subjNS := subj.Namespace
				if subjNS == "" {
					subjNS = rb.Namespace
				}
				saID := rgNodeID("ServiceAccount", subjNS, subj.Name)
				addNode(rgNode{
					ID: saID, Kind: "ServiceAccount", Name: subj.Name, Namespace: subjNS, Status: "Active",
				})
				edges = append(edges, rgEdge{Source: rbID, Target: saID, Type: RGEdgeBinds})
			}
		}
	}

	// --- ServiceAccounts (ensure nodes exist) ---
	for i := range res.serviceAccounts {
		sa := &res.serviceAccounts[i]
		if !inScope(sa.Namespace) {
			continue
		}
		addNode(rgNode{
			ID: rgNodeID("ServiceAccount", sa.Namespace, sa.Name), Kind: "ServiceAccount",
			Name: sa.Name, Namespace: sa.Namespace, Status: "Active",
		})
	}

	// --- ServiceAccount used by Deployments/DaemonSets ---
	for i := range res.deployments {
		d := &res.deployments[i]
		if !inScope(d.Namespace) {
			continue
		}
		saName := d.Spec.Template.Spec.ServiceAccountName
		if saName == "" {
			saName = "default"
		}
		saID := rgNodeID("ServiceAccount", d.Namespace, saName)
		if _, exists := nodeMap[saID]; exists {
			edges = append(edges, rgEdge{
				Source: saID,
				Target: rgNodeID("Deployment", d.Namespace, d.Name),
				Type:   RGEdgeSAUsedBy,
			})
		}
	}
	for i := range res.daemonSets {
		ds := &res.daemonSets[i]
		if !inScope(ds.Namespace) {
			continue
		}
		saName := ds.Spec.Template.Spec.ServiceAccountName
		if saName == "" {
			saName = "default"
		}
		saID := rgNodeID("ServiceAccount", ds.Namespace, saName)
		if _, exists := nodeMap[saID]; exists {
			edges = append(edges, rgEdge{
				Source: saID,
				Target: rgNodeID("DaemonSet", ds.Namespace, ds.Name),
				Type:   RGEdgeSAUsedBy,
			})
		}
	}

	return edges
}
