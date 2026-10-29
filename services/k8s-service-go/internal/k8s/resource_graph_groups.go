// resource_graph_groups.go — folds the pods of a large owner into groups, so a graph of many pods draws a box per
// group instead of a box per pod, and nothing it shows goes missing.
//
// A pod joins a group when its owner (ReplicaSet, StatefulSet, DaemonSet, Job …) has more than podGroupMin pods
// in the graph, it is healthy by the Cluster View card colour (podHealth) and it has the same edges as the
// group's other pods: an edge of a group stands for that edge of every member. A pod that is not healthy, or
// whose edges differ, stays a box of its own. A PVC whose name ends in "-<pod name>" (what a StatefulSet's
// volumeClaimTemplates make) counts as the same edge for every pod of the template, and those PVCs and their PVs
// are grouped with the pods. The page's grouping (node, instance) is part of the group, so a group never
// crosses it. Expand names groups drawn pod by pod.

package k8s

import (
	"fmt"
	"hash/fnv"
	"slices"
	"sort"
	"strings"
)

// podGroupMin: an owner's pods are grouped when it has more than this many in the graph (Headlamp collapses a
// group of more than 10, Argo CD's podGroupCount is 15).
const podGroupMin = 10

type rgGroup struct {
	id, namespace     string
	ownerKind, owner  string
	phase, groupValue string
	members           []string // pod IDs
	pvcTemplates      []string // the per-pod PVC templates of the members' edges
}

func groupID(kind, namespace, key string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	return fmt.Sprintf("group:%s/%s/%x", kind, namespace, h.Sum64())
}

// groupPods replaces the grouped pods (and their per-pod PVCs and PVs) in nodeMap with group nodes and returns
// the edges with their ends moved to the groups, one edge per (source, target, type) carrying how many it stands
// for.
func groupPods(nodeMap map[string]rgNode, edges []rgEdge, pods []rgPod, opts ResourceGraphOptions) []rgEdge {
	byID := map[string]rgPodInfo{}
	perOwner := map[string]int{}
	for i := range pods {
		p := &pods[i]
		id := rgNodeID("Pod", p.namespace, p.name)
		if _, shown := nodeMap[id]; !shown || len(p.owners) == 0 {
			continue
		}
		owner := rgNodeID(p.owners[0].Kind, p.namespace, p.owners[0].Name)
		byID[id] = rgPodInfo{pod: p, ownerID: owner}
		perOwner[owner]++
	}
	podEdges := map[string][]int{}
	for i, e := range edges {
		if _, ok := byID[e.Source]; ok {
			podEdges[e.Source] = append(podEdges[e.Source], i)
		}
		if _, ok := byID[e.Target]; ok {
			podEdges[e.Target] = append(podEdges[e.Target], i)
		}
	}
	expand := map[string]bool{}
	for _, id := range opts.Expand {
		expand[id] = true
	}

	groups := map[string]*rgGroup{}
	var order []string
	for podID, info := range byID {
		p := info.pod
		if perOwner[info.ownerID] <= podGroupMin || p.health != podHealthOK {
			continue
		}
		var parts, templates []string
		for _, i := range podEdges[podID] {
			e := edges[i]
			if e.Target == podID {
				if e.Type == RGEdgeOwns && e.Source == info.ownerID {
					continue
				}
				parts = append(parts, "in|"+e.Type+"|"+e.Source)
				continue
			}
			if tmpl, ok := perPodClaim(e, p); ok {
				status := nodeMap[e.Target].Status
				templates = append(templates, tmpl)
				parts = append(parts, "out|"+e.Type+"|claim-template:"+tmpl+":"+status)
				continue
			}
			parts = append(parts, "out|"+e.Type+"|"+e.Target)
		}
		sort.Strings(parts)
		parts = slices.Compact(parts)
		value := ""
		switch opts.GroupBy {
		case "node":
			value = p.node
		case "instance":
			value = p.labels["app.kubernetes.io/instance"]
		}
		key := strings.Join(append([]string{info.ownerID, p.phase, value}, parts...), "\n")
		id := groupID("Pod", p.namespace, key)
		if expand[id] {
			continue
		}
		g := groups[id]
		if g == nil {
			g = &rgGroup{id: id, namespace: p.namespace, ownerKind: p.owners[0].Kind, owner: p.owners[0].Name, phase: p.phase, groupValue: value}
			sort.Strings(templates)
			g.pvcTemplates = slices.Compact(templates)
			groups[id] = g
			order = append(order, id)
		}
		g.members = append(g.members, podID)
	}
	sort.Strings(order)

	moved := map[string]string{} // old node ID → group ID
	for _, id := range order {
		g := groups[id]
		if len(g.members) < 2 {
			continue
		}
		sort.Strings(g.members)
		node := rgNode{
			ID: g.id, Kind: "Pod", Name: g.owner, Namespace: g.namespace, Status: g.phase,
			Group: true, Count: len(g.members), OwnerKind: g.ownerKind, OwnerName: g.owner,
		}
		switch opts.GroupBy {
		case "node":
			node.NodeName = g.groupValue
		case "instance":
			node.InstanceLabel = g.groupValue
		}
		for _, podID := range g.members {
			p := byID[podID].pod
			node.Members = append(node.Members, p.name)
			if p.restarts > 0 {
				node.Restarted++
			}
			delete(nodeMap, podID)
			moved[podID] = g.id
		}
		nodeMap[g.id] = node
		for _, tmpl := range g.pvcTemplates {
			groupClaims(nodeMap, edges, g, tmpl, podsOf(byID, g.members), moved)
		}
	}
	if len(moved) == 0 {
		return edges
	}

	out := make([]rgEdge, 0, len(edges))
	at := map[string]int{}
	for _, e := range edges {
		if to, ok := moved[e.Source]; ok {
			e.Source = to
		}
		if to, ok := moved[e.Target]; ok {
			e.Target = to
		}
		k := e.Source + "|" + e.Target + "|" + e.Type
		if i, seen := at[k]; seen {
			out[i].Count++
			continue
		}
		if strings.HasPrefix(e.Source, "group:") || strings.HasPrefix(e.Target, "group:") {
			e.Count = 1
		}
		at[k] = len(out)
		out = append(out, e)
	}
	return out
}

type rgPodInfo struct {
	pod     *rgPod
	ownerID string
}

func podsOf(byID map[string]rgPodInfo, ids []string) []*rgPod {
	out := make([]*rgPod, 0, len(ids))
	for _, id := range ids {
		out = append(out, byID[id].pod)
	}
	return out
}

// perPodClaim: a mount of the PVC "<template>-<pod name>" — one per pod, as a StatefulSet's volumeClaimTemplates
// make them.
func perPodClaim(e rgEdge, p *rgPod) (string, bool) {
	if e.Type != RGEdgeMounts {
		return "", false
	}
	prefix := "PersistentVolumeClaim/" + p.namespace + "/"
	if !strings.HasPrefix(e.Target, prefix) {
		return "", false
	}
	name := strings.TrimPrefix(e.Target, prefix)
	tmpl, ok := strings.CutSuffix(name, "-"+p.name)
	return tmpl, ok && tmpl != ""
}

// groupClaims puts the members' PVCs of one template into a PVC group, and their PVs into a PV group when they
// share a status.
func groupClaims(nodeMap map[string]rgNode, edges []rgEdge, g *rgGroup, tmpl string, pods []*rgPod, moved map[string]string) {
	claimGroup := groupID("PersistentVolumeClaim", g.namespace, g.id+"\n"+tmpl)
	var claims []string
	claimSet := map[string]bool{}
	status := ""
	for _, p := range pods {
		id := rgNodeID("PersistentVolumeClaim", p.namespace, tmpl+"-"+p.name)
		n, listed := nodeMap[id]
		if !listed {
			continue
		}
		status = n.Status
		claims = append(claims, n.Name)
		claimSet[id] = true
		delete(nodeMap, id)
		moved[id] = claimGroup
	}
	if len(claims) == 0 {
		return
	}
	sort.Strings(claims)
	nodeMap[claimGroup] = rgNode{
		ID: claimGroup, Kind: "PersistentVolumeClaim", Name: tmpl + "-" + g.owner + "-*", Namespace: g.namespace,
		Status: status, Group: true, Count: len(claims), Members: claims, OwnerKind: g.ownerKind, OwnerName: g.owner,
	}

	var volumes []string
	volumeStatus := map[string]bool{}
	for _, e := range edges {
		if e.Type != RGEdgeBoundTo || !claimSet[e.Source] {
			continue
		}
		if n, listed := nodeMap[e.Target]; listed {
			volumes = append(volumes, e.Target)
			volumeStatus[n.Status] = true
		}
	}
	if len(volumes) < 2 || len(volumeStatus) != 1 {
		return
	}
	volumeGroup := groupID("PersistentVolume", "", claimGroup)
	node := rgNode{ID: volumeGroup, Kind: "PersistentVolume", Name: tmpl + "-" + g.owner + "-*", Group: true, Count: len(volumes), OwnerKind: g.ownerKind, OwnerName: g.owner}
	sort.Strings(volumes)
	for _, id := range volumes {
		n := nodeMap[id]
		node.Status = n.Status
		node.Members = append(node.Members, n.Name)
		delete(nodeMap, id)
		moved[id] = volumeGroup
	}
	nodeMap[volumeGroup] = node
}
