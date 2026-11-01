# An installer's rule: every Deployment names its team.
package kubeast.deploy

import rego.v1

finding contains f if {
	some obj in input.objects
	obj.kind == "Deployment"
	not obj.metadata.labels["team.example.com/owner"]
	f := {"rule": "team-label", "kind": obj.kind, "name": obj.metadata.name, "msg": "label team.example.com/owner is required"}
}
