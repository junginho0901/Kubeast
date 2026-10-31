package render

import (
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/spec"
)

func (r *renderer) autoscaler() {
	a := r.ext.Autoscale
	if a == nil {
		return
	}
	r.add("autoscaling/v2", "HorizontalPodAutoscaler", r.name, nil, Object{
		"spec": Object{
			"scaleTargetRef": Object{"apiVersion": "apps/v1", "kind": "Deployment", "name": r.name},
			"minReplicas":    a.Min,
			"maxReplicas":    a.Max,
			"metrics": []interface{}{Object{
				"type": "Resource",
				"resource": Object{
					"name":   a.Resource,
					"target": Object{"type": "Utilization", "averageUtilization": a.Target},
				},
			}},
		},
	})
}

// disruptionBudget follows the company chart: none with one replica (a
// budget there would block every drain), maxUnavailable 1 from two up.
func (r *renderer) disruptionBudget() {
	least := r.replicas()
	if r.ext.Autoscale != nil {
		least = r.ext.Autoscale.Min
	}
	budget := Object{"selector": Object{"matchLabels": r.selector()}}
	switch p := r.ext.PDB; p.Mode {
	case spec.PDBOff:
		return
	case spec.PDBAuto:
		if least < 2 {
			return
		}
		budget["maxUnavailable"] = 1
	case spec.PDBMaxUnavailable:
		budget["maxUnavailable"] = p.Value
	case spec.PDBMinAvailable:
		budget["minAvailable"] = p.Value
		if p.Value >= least {
			r.note("annotation %s: min-available=%d with at least %d replica(s) lets no pod be evicted, so drains wait", spec.KeyPDB, p.Value, least)
		}
	}
	r.add("policy/v1", "PodDisruptionBudget", r.name, nil, Object{"spec": budget})
}

func (r *renderer) serviceMonitor() {
	s := r.ext.Scrape
	if s == nil {
		return
	}
	if _, ok := r.ownPorts()[s.Port]; !ok {
		r.fail("annotation %s: %q is not a port name in service.ports", spec.KeyScrape, s.Port)
		return
	}
	if !r.env.Capabilities.ServiceMonitor {
		r.note("annotation %s: no ServiceMonitor, the target cluster of environment %q has no prometheus-operator", spec.KeyScrape, r.env.Name)
		return
	}
	r.add("monitoring.coreos.com/v1", "ServiceMonitor", r.name, nil, Object{
		"spec": Object{
			"selector":  Object{"matchLabels": r.selector()},
			"endpoints": []interface{}{Object{"port": s.Port, "path": s.Path}},
		},
	})
}
