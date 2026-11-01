# The gate's default policy: Pod Security Standards "restricted" and the
# platform's general rules. Every rule has an ID, the name an environment's
# rule modes and a workload's policy exceptions use.
#
# Input: {"objects": [...], "allowed_registries": [...]}.
# Output: data.kubeast.deploy.finding, a set of {rule, kind, name, msg}.
# An installer's own modules add to the same set in the same package.
package kubeast.deploy

import rego.v1

workload_kinds := {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"}

pod_spec(obj) := obj.spec.template.spec if obj.kind in workload_kinds

pod_spec(obj) := obj.spec.jobTemplate.spec.template.spec if obj.kind == "CronJob"

pod_spec(obj) := obj.spec if obj.kind == "Pod"

pods contains {"obj": obj, "spec": spec} if {
	some obj in input.objects
	spec := pod_spec(obj)
}

# Pod Security "restricted" covers init and ephemeral containers too.
all_containers(spec) := array.concat(
	array.concat(object.get(spec, "containers", []), object.get(spec, "initContainers", [])),
	object.get(spec, "ephemeralContainers", []),
)

found(rule, obj, msg) := {"rule": rule, "kind": obj.kind, "name": obj.metadata.name, "msg": msg}

# --- Pod Security "restricted" -------------------------------------------

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	object.get(c, ["securityContext", "runAsNonRoot"], object.get(spec, ["securityContext", "runAsNonRoot"], false)) != true
	f := found("run-as-non-root", obj, sprintf("container %s: runAsNonRoot must be true (on the container or the pod)", [c.name]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	spec.securityContext.runAsUser == 0
	f := found("run-as-user-not-root", obj, "the pod sets runAsUser 0")
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	c.securityContext.runAsUser == 0
	f := found("run-as-user-not-root", obj, sprintf("container %s: runAsUser 0", [c.name]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	object.get(c, ["securityContext", "allowPrivilegeEscalation"], true) != false
	f := found("no-privilege-escalation", obj, sprintf("container %s: allowPrivilegeEscalation must be false", [c.name]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	not "ALL" in object.get(c, ["securityContext", "capabilities", "drop"], [])
	f := found("drop-all-capabilities", obj, sprintf("container %s: capabilities.drop must hold ALL", [c.name]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	some cap in object.get(c, ["securityContext", "capabilities", "add"], [])
	cap != "NET_BIND_SERVICE"
	f := found("drop-all-capabilities", obj, sprintf("container %s: adds capability %s (only NET_BIND_SERVICE is allowed)", [c.name, cap]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	t := object.get(c, ["securityContext", "seccompProfile", "type"], object.get(spec, ["securityContext", "seccompProfile", "type"], ""))
	not t in {"RuntimeDefault", "Localhost"}
	f := found("seccomp-profile", obj, sprintf("container %s: seccompProfile.type must be RuntimeDefault or Localhost (on the container or the pod)", [c.name]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	c.securityContext.privileged == true
	f := found("no-privileged", obj, sprintf("container %s: privileged", [c.name]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some field in ["hostNetwork", "hostPID", "hostIPC"]
	spec[field] == true
	f := found("no-host-namespaces", obj, sprintf("%s is true", [field]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some v in object.get(spec, "volumes", [])
	v.hostPath
	f := found("no-host-path", obj, sprintf("volume %s is a hostPath", [v.name]))
}

# --- The platform's golden path --------------------------------------------

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	object.get(spec, "hostUsers", true) != false
	f := found("host-users", obj, "hostUsers must be false (a user namespace per pod)")
}

# A workload that writes to its root says why with kubeast.io/read-only-root-reason,
# which the renderer writes on the object; the reason stands in for the rule.
finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	object.get(obj, ["metadata", "annotations", "kubeast.io/read-only-root-reason"], "") == ""
	some c in object.get(spec, "containers", [])
	object.get(c, ["securityContext", "readOnlyRootFilesystem"], false) != true
	f := found("read-only-root", obj, sprintf("container %s: readOnlyRootFilesystem must be true, or the object carries kubeast.io/read-only-root-reason", [c.name]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in object.get(spec, "containers", [])
	some r in ["cpu", "memory"]
	not c.resources.requests[r]
	f := found("resource-requests", obj, sprintf("container %s: resources.requests.%s is required", [c.name, r]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in object.get(spec, "containers", [])
	not c.resources.limits.memory
	f := found("memory-limit", obj, sprintf("container %s: resources.limits.memory is required", [c.name]))
}

image_name(image) := parts[count(parts) - 1] if parts := split(image, "/")

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	not contains(image_name(c.image), ":")
	not contains(c.image, "@sha256:")
	f := found("image-tag", obj, sprintf("container %s: image %s has no tag or digest", [c.name, c.image]))
}

finding contains f if {
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	endswith(c.image, ":latest")
	f := found("no-latest-tag", obj, sprintf("container %s: image %s uses the latest tag", [c.name, c.image]))
}

finding contains f if {
	count(object.get(input, "allowed_registries", [])) > 0
	some p in pods
	obj := p.obj
	spec := p.spec
	some c in all_containers(spec)
	not from_allowed(c.image)
	f := found("allowed-registry", obj, sprintf("container %s: image %s is not from %v", [c.name, c.image, input.allowed_registries]))
}

from_allowed(image) if {
	some prefix in input.allowed_registries
	startswith(image, prefix)
}
