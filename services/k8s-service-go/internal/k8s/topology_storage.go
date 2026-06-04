package k8s

import (
	"context"
	"fmt"
	"sync"
)

// GetStorageTopology returns a topology graph for storage resources.
func (s *Service) GetStorageTopology(ctx context.Context) (map[string]interface{}, error) {
	var pvcs []map[string]interface{}
	var pvs []map[string]interface{}
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	wg.Add(2)
	go func() {
		defer wg.Done()
		data, err := s.GetAllPVCs(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil && firstErr == nil {
			firstErr = err
		}
		pvcs = data
	}()
	go func() {
		defer wg.Done()
		data, err := s.GetPVs(ctx)
		mu.Lock()
		defer mu.Unlock()
		if err != nil && firstErr == nil {
			firstErr = err
		}
		pvs = data
	}()
	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}

	nodes := make([]map[string]interface{}, 0)
	edges := make([]map[string]interface{}, 0)
	edgeID := 0

	// PV nodes
	for _, pv := range pvs {
		nodes = append(nodes, map[string]interface{}{
			"id":     fmt.Sprintf("pv-%s", pv["name"]),
			"type":   NodeTypePV,
			"name":   pv["name"],
			"status": pv["status"],
			"metadata": map[string]interface{}{
				"capacity":      pv["capacity"],
				"storage_class": pv["storage_class"],
				"access_modes":  pv["access_modes"],
			},
		})
	}

	// PVC nodes + edges to PVs
	for _, pvc := range pvcs {
		ns, _ := pvc["namespace"].(string)
		nodes = append(nodes, map[string]interface{}{
			"id":        fmt.Sprintf("pvc-%s-%s", ns, pvc["name"]),
			"type":      NodeTypePVC,
			"name":      pvc["name"],
			"namespace": ns,
			"status":    pvc["status"],
			"metadata": map[string]interface{}{
				"capacity":      pvc["capacity"],
				"storage_class": pvc["storage_class"],
			},
		})

		volumeName, _ := pvc["volume_name"].(string)
		if volumeName != "" {
			edgeID++
			edges = append(edges, map[string]interface{}{
				"id":     fmt.Sprintf("edge-%d", edgeID),
				"source": fmt.Sprintf("pvc-%s-%s", ns, pvc["name"]),
				"target": fmt.Sprintf("pv-%s", volumeName),
				"type":   EdgeTypeBoundTo,
				"label":  "bound to",
			})
		}
	}

	return map[string]interface{}{
		"nodes": nodes,
		"edges": edges,
		"metadata": map[string]interface{}{
			"pv_count":  len(pvs),
			"pvc_count": len(pvcs),
		},
	}, nil
}
