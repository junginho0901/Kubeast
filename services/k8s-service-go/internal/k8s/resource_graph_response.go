// resource_graph_response.go — resource-graph 의 최종 응답 (dedupe + map 변환) 빌더.
//
// resource_graph.go 의 GetResourceGraph 내부에서 분리. (1) edge 중복 제거,
// (2) nodeMap / uniqueEdges 를 map[string]interface{} 로 JSON-friendly 변환.

package k8s

// buildResourceGraphResponse converts the accumulated nodeMap + edges into the
// final response payload. Edges are deduplicated by (source, target, type)
// triple; node fields are emitted only when non-empty to keep the JSON compact.
func buildResourceGraphResponse(nodeMap map[string]rgNode, edges []rgEdge) map[string]interface{} {
	// ========== DEDUPLICATE EDGES ==========
	edgeSet := make(map[string]bool)
	uniqueEdges := make([]rgEdge, 0, len(edges))
	for _, e := range edges {
		key := e.Source + "|" + e.Target + "|" + e.Type
		if !edgeSet[key] {
			edgeSet[key] = true
			uniqueEdges = append(uniqueEdges, e)
		}
	}

	// ========== BUILD RESPONSE ==========
	nodeList := make([]map[string]interface{}, 0, len(nodeMap))
	for _, n := range nodeMap {
		node := map[string]interface{}{
			"id":        n.ID,
			"kind":      n.Kind,
			"name":      n.Name,
			"namespace": n.Namespace,
			"status":    n.Status,
		}
		if n.Ready != "" {
			node["ready"] = n.Ready
		}
		if len(n.Labels) > 0 {
			node["labels"] = n.Labels
		}
		if n.NodeName != "" {
			node["nodeName"] = n.NodeName
		}
		if n.OwnerKind != "" {
			node["ownerKind"] = n.OwnerKind
		}
		if n.InstanceLabel != "" {
			node["instanceLabel"] = n.InstanceLabel
		}
		nodeList = append(nodeList, node)
	}

	edgeList := make([]map[string]interface{}, 0, len(uniqueEdges))
	for _, e := range uniqueEdges {
		edgeList = append(edgeList, map[string]interface{}{
			"source": e.Source,
			"target": e.Target,
			"type":   e.Type,
		})
	}

	return map[string]interface{}{
		"nodes": nodeList,
		"edges": edgeList,
	}
}
