package render

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/score-spec/score-go/types"

	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/spec"
	"github.com/junginho0901/kubeast/services/deploy-service-go/internal/target"
)

var volumeSource = regexp.MustCompile(`^\$\{resources\.([^.}]+)\}$`)

// filesOut is the ConfigMap the containers' files go in.
type filesOut struct {
	volume Object
	mounts map[string][]interface{}
	hash   string
}

// files puts every container file in one ConfigMap, each mounted on its own
// path through subPath. A subPath mount does not follow ConfigMap updates, so
// the pod template carries a hash of the data and rolls when it changes.
func (r *renderer) files() *filesOut {
	out := &filesOut{mounts: map[string][]interface{}{}}
	data, binary := map[string]interface{}{}, map[string]interface{}{}
	var items []interface{}
	for _, cname := range sortedKeys(r.w.Containers) {
		c := r.w.Containers[cname]
		for i, target := range sortedKeys(c.Files) {
			f := c.Files[target]
			key := fmt.Sprintf("%s-%d-%s", cname, i, keyPart(path.Base(target)))
			switch {
			case f.Content != nil:
				content := *f.Content
				if f.NoExpand == nil || !*f.NoExpand {
					var err error
					if content, err = r.subst(content); err != nil {
						r.fail("container %q file %q: %v", cname, target, err)
						continue
					}
					if hasSecret(content) {
						r.fail("container %q file %q: a secret output cannot go into a file in this version; pass it as a variable", cname, target)
						continue
					}
				}
				data[key] = content
			case f.BinaryContent != nil:
				binary[key] = *f.BinaryContent
			default:
				r.fail("container %q file %q: no content", cname, target)
				continue
			}
			item := Object{"key": key, "path": key}
			if f.Mode != nil {
				m, err := strconv.ParseUint(*f.Mode, 8, 32)
				if err != nil || m > 0o777 {
					r.fail("container %q file %q: mode %q is not an octal file mode", cname, target, *f.Mode)
					continue
				}
				item["mode"] = int(m)
			}
			items = append(items, item)
			out.mounts[cname] = append(out.mounts[cname], Object{"name": "files", "mountPath": target, "subPath": key, "readOnly": true})
		}
	}
	if len(items) == 0 {
		return out
	}
	name := r.name + "-files"
	fields := Object{}
	if len(data) > 0 {
		fields["data"] = data
	}
	if len(binary) > 0 {
		fields["binaryData"] = binary
	}
	r.add("v1", "ConfigMap", name, nil, fields)
	out.volume = Object{"name": "files", "configMap": Object{"name": name, "items": items}}
	out.hash = hashData(data, binary)
	return out
}

func keyPart(s string) string {
	return strings.Map(func(c rune) rune {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '.', c == '_':
			return c
		}
		return '_'
	}, s)
}

func hashData(maps ...map[string]interface{}) string {
	h := sha256.New()
	for _, m := range maps {
		for _, k := range sortedKeys(m) {
			fmt.Fprintf(h, "%s\x00%s\x00", k, m[k])
		}
		h.Write([]byte{1})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// firstServicePort is the target port of the first service port by name.
func (r *renderer) firstServicePort() int {
	if r.w.Service == nil || len(r.w.Service.Ports) == 0 {
		return 0
	}
	p := r.w.Service.Ports[sortedKeys(r.w.Service.Ports)[0]]
	if p.TargetPort != nil {
		return *p.TargetPort
	}
	return p.Port
}

func (r *renderer) containers(files *filesOut) []interface{} {
	single := len(r.w.Containers) == 1
	readinessPort := 0
	if single && *r.env.ReadinessFromPort {
		readinessPort = r.firstServicePort()
	}
	var out []interface{}
	for _, cname := range sortedKeys(r.w.Containers) {
		c := r.w.Containers[cname]
		if c.Image == "." || c.Image == "" {
			r.fail("container %q: image %q needs the image from the environment values file", cname, c.Image)
			continue
		}
		ct := Object{"name": cname, "image": c.Image}
		if len(c.Command) > 0 {
			ct["command"] = strList(c.Command)
		}
		if len(c.Args) > 0 {
			ct["args"] = strList(c.Args)
		}
		if env := r.envVars(cname, c.Variables); len(env) > 0 {
			ct["env"] = env
		}
		ct["resources"] = r.resources(cname, c.Resources)
		if c.LivenessProbe != nil {
			if p := r.probe(cname, "livenessProbe", c.LivenessProbe); p != nil {
				ct["livenessProbe"] = p
			}
		}
		switch {
		case c.ReadinessProbe != nil:
			if p := r.probe(cname, "readinessProbe", c.ReadinessProbe); p != nil {
				ct["readinessProbe"] = p
			}
		case readinessPort > 0:
			ct["readinessProbe"] = Object{"tcpSocket": Object{"port": readinessPort}}
		}
		sc := Object{
			"allowPrivilegeEscalation": false,
			"capabilities":             Object{"drop": []interface{}{"ALL"}},
			"readOnlyRootFilesystem":   r.ext.ReadOnlyRoot,
		}
		if r.ext.RunAsUser != nil {
			sc["runAsUser"] = *r.ext.RunAsUser
		}
		ct["securityContext"] = sc
		if mounts := r.volumeMounts(cname, c, files); len(mounts) > 0 {
			ct["volumeMounts"] = mounts
		}
		out = append(out, ct)
	}
	return out
}

// resources fills what the container leaves out from the environment. A
// default memory limit below the container's own request is raised to it.
func (r *renderer) resources(cname string, cr *types.ContainerResources) Object {
	var req, lim types.ResourcesLimits
	if cr != nil {
		if cr.Requests != nil {
			req = *cr.Requests
		}
		if cr.Limits != nil {
			lim = *cr.Limits
		}
	}
	d := r.env.Resources
	requests := Object{"cpu": or(req.Cpu, d.Requests.CPU), "memory": or(req.Memory, d.Requests.Memory)}
	limits := Object{}
	if lim.Cpu != nil {
		limits["cpu"] = *lim.Cpu
	}
	memLimit := or(lim.Memory, d.Limits.Memory)
	if lim.Memory == nil && req.Memory != nil {
		_, reqBytes, err1 := types.ParseResourceLimits(types.ResourcesLimits{Memory: req.Memory})
		_, limBytes, err2 := types.ParseResourceLimits(types.ResourcesLimits{Memory: &memLimit})
		switch {
		case err1 != nil || err2 != nil:
			r.fail("container %q resources: %v", cname, firstErr(err1, err2))
		case *reqBytes > *limBytes:
			memLimit = *req.Memory
		}
	}
	limits["memory"] = memLimit
	return Object{"requests": requests, "limits": limits}
}

func or(v *string, def string) string {
	if v != nil && *v != "" {
		return *v
	}
	return def
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

func (r *renderer) probe(cname, field string, p *types.ContainerProbe) Object {
	switch {
	case p.HttpGet != nil && p.Exec != nil:
		r.fail("container %q %s: httpGet or exec, not both", cname, field)
	case p.HttpGet != nil:
		hg := Object{"path": p.HttpGet.Path, "port": p.HttpGet.Port}
		if p.HttpGet.Host != nil {
			hg["host"] = *p.HttpGet.Host
		}
		if p.HttpGet.Scheme != nil {
			hg["scheme"] = string(*p.HttpGet.Scheme)
		}
		if len(p.HttpGet.HttpHeaders) > 0 {
			hs := make([]interface{}, len(p.HttpGet.HttpHeaders))
			for i, h := range p.HttpGet.HttpHeaders {
				hs[i] = Object{"name": h.Name, "value": h.Value}
			}
			hg["httpHeaders"] = hs
		}
		return Object{"httpGet": hg}
	case p.Exec != nil:
		return Object{"exec": Object{"command": strList(p.Exec.Command)}}
	default:
		r.fail("container %q %s: needs httpGet or exec", cname, field)
	}
	return nil
}

func (r *renderer) volumeMounts(cname string, c types.Container, files *filesOut) []interface{} {
	var mounts []interface{}
	hasTmp := false
	for _, target := range sortedKeys(c.Volumes) {
		v := c.Volumes[target]
		m := volumeSource.FindStringSubmatch(v.Source)
		if m == nil {
			r.fail("container %q volume %q: source must be ${resources.<volume resource>}", cname, target)
			continue
		}
		vol, ok := r.volumes[m[1]]
		if !ok {
			r.fail("container %q volume %q: %q is not a volume resource", cname, target, m[1])
			continue
		}
		r.usedVolumes[m[1]] = true
		mt := Object{"name": vol["name"], "mountPath": target}
		if v.Path != nil {
			mt["subPath"] = *v.Path
		}
		if v.ReadOnly != nil && *v.ReadOnly {
			mt["readOnly"] = true
		}
		hasTmp = hasTmp || path.Clean(target) == "/tmp"
		mounts = append(mounts, mt)
	}
	mounts = append(mounts, files.mounts[cname]...)
	if !hasTmp {
		mounts = append(mounts, Object{"name": "tmp", "mountPath": "/tmp"})
		r.needTmp = true
	}
	sort.SliceStable(mounts, func(i, j int) bool {
		return mounts[i].(Object)["mountPath"].(string) < mounts[j].(Object)["mountPath"].(string)
	})
	return mounts
}

func (r *renderer) serviceAccount() {
	ann := Object{}
	kubeAPI := false
	if r.sa != nil {
		kubeAPI = r.sa.kubeAPI
		if r.sa.class == "aws-irsa" {
			ann["eks.amazonaws.com/role-arn"] = r.sa.roleARN
		}
	}
	r.add("v1", "ServiceAccount", r.name, ann, Object{"automountServiceAccountToken": kubeAPI})
}

func (r *renderer) externalSecrets() {
	store := r.env.SecretStore
	for _, id := range sortedKeys(r.secrets) {
		sr := r.secrets[id]
		if len(sr.used) == 0 {
			r.note("resource %q (secret): no ExternalSecret, nothing refers to it", id)
			continue
		}
		data := make([]interface{}, 0, len(sr.used))
		for _, k := range sortedKeys(sr.used) {
			prop := k
			if p, ok := sr.properties[k]; ok {
				prop = p
			}
			data = append(data, Object{"secretKey": k, "remoteRef": Object{"key": sr.key, "property": prop}})
		}
		name := r.secretName(id)
		r.add("external-secrets.io/v1", "ExternalSecret", name, nil, Object{
			"spec": Object{
				"refreshInterval": store.RefreshInterval,
				"secretStoreRef":  Object{"kind": store.Kind, "name": store.Name},
				"target":          Object{"name": name, "creationPolicy": "Owner"},
				"data":            data,
			},
		})
	}
}

func (r *renderer) service() {
	if r.w.Service == nil || len(r.w.Service.Ports) == 0 {
		return
	}
	var ports []interface{}
	for _, name := range sortedKeys(r.w.Service.Ports) {
		p := r.w.Service.Ports[name]
		targetPort := p.Port
		if p.TargetPort != nil {
			targetPort = *p.TargetPort
		}
		protocol := "TCP"
		if p.Protocol != nil {
			protocol = string(*p.Protocol)
		}
		ports = append(ports, Object{"name": name, "port": p.Port, "targetPort": targetPort, "protocol": protocol})
	}
	r.add("v1", "Service", r.name, nil, Object{"spec": Object{"selector": r.selector(), "ports": ports}})
}

var topologyKeys = map[string]string{
	spec.SpreadZone:     "topology.kubernetes.io/zone",
	spec.SpreadHostname: "kubernetes.io/hostname",
}

func (r *renderer) deployment(containers []interface{}, files *filesOut, profile *target.Profile) {
	pod := Object{
		"serviceAccountName":           r.name,
		"automountServiceAccountToken": r.sa != nil && r.sa.kubeAPI,
		"securityContext": Object{
			"runAsNonRoot":   true,
			"seccompProfile": Object{"type": "RuntimeDefault"},
		},
		"containers": containers,
	}
	hostUsers := r.env.HostUsers
	if r.ext.HostUsers != nil {
		hostUsers = *r.ext.HostUsers
	}
	if !hostUsers {
		pod["hostUsers"] = false
	}

	spread := *r.env.Spread
	if r.ext.Spread != nil {
		spread = r.ext.Spread
	}
	if len(spread) > 0 {
		tsc := make([]interface{}, 0, len(spread))
		for _, s := range spread {
			tsc = append(tsc, Object{
				"maxSkew":           1,
				"topologyKey":       topologyKeys[s],
				"whenUnsatisfiable": "ScheduleAnyway",
				"labelSelector":     Object{"matchLabels": r.selector()},
			})
		}
		pod["topologySpreadConstraints"] = tsc
	}

	if profile != nil {
		if len(profile.NodeSelector) > 0 {
			ns := Object{}
			for k, v := range profile.NodeSelector {
				ns[k] = v
			}
			pod["nodeSelector"] = ns
		}
		if len(profile.Tolerations) > 0 {
			ts := make([]interface{}, len(profile.Tolerations))
			for i, t := range profile.Tolerations {
				o := Object{}
				for k, v := range map[string]string{"key": t.Key, "operator": t.Operator, "value": t.Value, "effect": t.Effect} {
					if v != "" {
						o[k] = v
					}
				}
				if t.TolerationSeconds != nil {
					o["tolerationSeconds"] = *t.TolerationSeconds
				}
				ts[i] = o
			}
			pod["tolerations"] = ts
		}
	}

	var volumes []interface{}
	if r.needTmp {
		volumes = append(volumes, Object{"name": "tmp", "emptyDir": Object{"sizeLimit": r.env.TmpSize}})
	}
	if files.volume != nil {
		volumes = append(volumes, files.volume)
	}
	for _, id := range sortedKeys(r.volumes) {
		if r.usedVolumes[id] {
			volumes = append(volumes, r.volumes[id])
		} else {
			r.note("resource %q (volume): not mounted by any container", id)
		}
	}
	if len(volumes) > 0 {
		sort.SliceStable(volumes, func(i, j int) bool {
			return volumes[i].(Object)["name"].(string) < volumes[j].(Object)["name"].(string)
		})
		pod["volumes"] = volumes
	}

	tmplMeta := Object{"labels": r.labels()}
	if files.hash != "" {
		tmplMeta["annotations"] = Object{annFilesHash: files.hash}
	}
	deploySpec := Object{
		"selector": Object{"matchLabels": r.selector()},
		"strategy": Object{
			"type":          "RollingUpdate",
			"rollingUpdate": Object{"maxSurge": intOrPercent(r.env.MaxSurge), "maxUnavailable": 0},
		},
		"template": Object{"metadata": tmplMeta, "spec": pod},
	}
	if r.ext.Autoscale == nil {
		deploySpec["replicas"] = r.replicas()
	}
	// What the workload is let off stays visible on the object itself, also
	// to someone who only has kubectl.
	ann := Object{}
	if !r.ext.ReadOnlyRoot {
		ann[spec.KeyReadOnlyRootReason] = r.ext.ReadOnlyRootReason
	}
	if len(r.ext.PolicyExceptions) > 0 {
		ann[spec.KeyPolicyException] = strings.Join(r.ext.PolicyExceptions, ",")
		ann[spec.KeyPolicyExceptionReason] = r.ext.PolicyExceptionReason
	}
	r.add("apps/v1", "Deployment", r.name, ann, Object{"spec": deploySpec})
}

// intOrPercent writes "3" as the number 3: Kubernetes reads a string
// int-or-string only as a percentage and refuses "3".
func intOrPercent(s string) interface{} {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return s
}
