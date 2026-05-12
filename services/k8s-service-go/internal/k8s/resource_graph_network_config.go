// resource_graph_network_config.go — resource-graph 의 network/config 노드·엣지 빌더.
//
// resource_graph.go 의 GetResourceGraph 내부에서 분리. Services / ConfigMaps /
// Secrets / Ingresses / HPAs / NetworkPolicies / EndpointSlices / Endpoints 8 도메인.
// closure (`inScope`, `addNode`) 는 호출자에서 그대로 전달 받음 — 본문 byte-equal 유지.
//
// 원본 순서상 Services → CM → Secrets → (PVCs/PVs/SC: PR4) → Ingresses → HPAs →
// NP → EpSlice → Endpoints 였으나, storage 3 섹션이 PR4 로 이동하면서
// 본 함수 내부는 storage 빠진 8 섹션을 연속 수행. node dedup + edge dedup 보장으로
// 최종 출력은 동일.

package k8s

import "fmt"

// buildNetworkConfigGraph populates the resource graph with network and
// configuration nodes/edges (Services, ConfigMaps, Secrets, Ingresses, HPAs,
// NetworkPolicies, EndpointSlices, Endpoints).
//
// nodeMap is mutated in-place. The updated edges slice is returned (append
// may reallocate, so the caller must reassign).
func buildNetworkConfigGraph(
	res *rgResources,
	nodeMap map[string]rgNode,
	addNode func(rgNode),
	edges []rgEdge,
	inScope func(string) bool,
) []rgEdge {
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
		svcName := eps.Labels["kubernetes.io/service-name"]
		if svcName != "" {
			epsID := rgNodeID("EndpointSlice", eps.Namespace, eps.Name)
			addNode(rgNode{
				ID: epsID, Kind: "EndpointSlice",
				Name: eps.Name, Namespace: eps.Namespace, Status: "Active",
			})
			svcID := rgNodeID("Service", eps.Namespace, svcName)
			edges = append(edges, rgEdge{Source: epsID, Target: svcID, Type: RGEdgeEndpointOf})
		}
	}

	// --- Endpoints → Service ---
	for i := range res.endpoints {
		ep := &res.endpoints[i]
		if !inScope(ep.Namespace) {
			continue
		}
		epID := rgNodeID("Endpoints", ep.Namespace, ep.Name)
		addNode(rgNode{
			ID: epID, Kind: "Endpoints",
			Name: ep.Name, Namespace: ep.Namespace, Status: "Active",
		})
		// Endpoints share name with Service
		svcID := rgNodeID("Service", ep.Namespace, ep.Name)
		if _, exists := nodeMap[svcID]; exists {
			edges = append(edges, rgEdge{Source: epID, Target: svcID, Type: RGEdgeEndpointOf})
		}
	}

	return edges
}
