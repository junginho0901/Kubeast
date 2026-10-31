package render

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/score-spec/score-go/framework"
)

// provisionOrder is the order resources are provisioned in, so a route can
// use a dns resource's host in its params. Types not listed are refused.
var provisionOrder = map[string]int{
	"dns":             0,
	"service-port":    1,
	"volume":          2,
	"secret":          3,
	"service-account": 4,
	"route":           5,
}

var (
	hostname  = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
	routePath = regexp.MustCompile(`^(/|(/[^/\s]+)+)$`)
	roleARN   = regexp.MustCompile(`^arn:aws[a-z-]*:iam::\d{12}:role/.+$`)
	secretKey = regexp.MustCompile(`^[-._a-zA-Z0-9]+$`)
)

type secretRes struct {
	id         string
	key        string
	properties map[string]string
	used       map[string]bool
}

type saRes struct {
	class   string
	roleARN string
	kubeAPI bool
}

func (r *renderer) provision() {
	ids := sortedKeys(r.w.Resources)
	for _, id := range ids {
		if _, ok := provisionOrder[r.w.Resources[id].Type]; !ok {
			r.fail("resource %q: type %q is not supported (%s)", id, r.w.Resources[id].Type, supportedTypes())
		}
	}
	if len(r.errs) > 0 {
		return
	}
	sort.SliceStable(ids, func(i, j int) bool {
		return provisionOrder[r.w.Resources[ids[i]].Type] < provisionOrder[r.w.Resources[ids[j]].Type]
	})

	for _, id := range ids {
		res := r.w.Resources[id]
		class := ""
		if res.Class != nil {
			class = *res.Class
		}
		if class != "" && class != "default" && res.Type != "secret" && res.Type != "service-account" {
			r.fail("resource %q (%s): class %q is not supported", id, res.Type, class)
			continue
		}
		raw, err := framework.Substitute(map[string]interface{}(res.Params), r.lookup)
		if err != nil {
			r.fail("resource %q (%s) params: %v", id, res.Type, err)
			continue
		}
		params, _ := raw.(map[string]interface{})
		if params == nil {
			params = map[string]interface{}{}
		}
		if hasSecret(params) {
			r.fail("resource %q (%s) params: a secret output cannot go into params", id, res.Type)
			continue
		}
		switch res.Type {
		case "dns":
			r.dns(id, params)
		case "service-port":
			r.servicePort(id, params)
		case "volume":
			r.volume(id, params)
		case "secret":
			r.secret(id, class, params)
		case "service-account":
			r.serviceAccountResource(id, class, params)
		case "route":
			r.route(id, params)
		}
	}
}

func supportedTypes() string {
	names := make([]string, 0, len(provisionOrder))
	for t := range provisionOrder {
		names = append(names, t)
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// onlyParams refuses params a provisioner does not read, so a typo fails.
func (r *renderer) onlyParams(id, typ string, params map[string]interface{}, allowed ...string) bool {
	ok := true
	for _, k := range sortedKeys(params) {
		found := false
		for _, a := range allowed {
			if k == a {
				found = true
				break
			}
		}
		if !found {
			r.fail("resource %q (%s): unknown param %q (known: %s)", id, typ, k, strings.Join(allowed, ", "))
			ok = false
		}
	}
	return ok
}

func (r *renderer) stringParam(id, typ string, params map[string]interface{}, key string) (string, bool) {
	v, present := params[key]
	if !present || v == nil {
		return "", true
	}
	s, isString := v.(string)
	if !isString {
		r.fail("resource %q (%s): param %q must be a string", id, typ, key)
		return "", false
	}
	return s, true
}

func lookupMap(id string, m map[string]interface{}) framework.OutputLookupFunc {
	return func(keys ...string) (interface{}, error) {
		if len(keys) == 0 {
			return m, nil
		}
		v, ok := m[keys[0]]
		if !ok || len(keys) > 1 {
			return nil, fmt.Errorf("resource %q has no output %q (outputs: %s)", id, strings.Join(keys, "."), strings.Join(sortedKeys(m), ", "))
		}
		return v, nil
	}
}

func (r *renderer) dns(id string, params map[string]interface{}) {
	if !r.onlyParams(id, "dns", params, "host") {
		return
	}
	host, ok := r.stringParam(id, "dns", params, "host")
	if !ok {
		return
	}
	if host == "" {
		host = r.env.HostFor(r.name, id)
	}
	if host == "" {
		r.fail("resource %q (dns): no params.host and environment %q has no domain", id, r.env.Name)
		return
	}
	if !hostname.MatchString(host) || len(host) > 253 {
		r.fail("resource %q (dns): %q is not a host name", id, host)
		return
	}
	r.outputs[id] = lookupMap(id, map[string]interface{}{"host": host})
}

// portNumber reads a port param: a port name or number. byName resolves names.
func portNumber(v interface{}, byName map[string]int) (int, string, bool) {
	switch p := v.(type) {
	case int:
		return p, "", true
	case float64:
		return int(p), "", p == float64(int(p))
	case string:
		if n, err := strconv.Atoi(p); err == nil {
			return n, "", true
		}
		n, ok := byName[p]
		return n, p, ok
	}
	return 0, "", false
}

func (r *renderer) ownPorts() map[string]int {
	out := map[string]int{}
	if r.w.Service != nil {
		for name, p := range r.w.Service.Ports {
			out[name] = p.Port
		}
	}
	return out
}

func (r *renderer) servicePort(id string, params map[string]interface{}) {
	if !r.onlyParams(id, "service-port", params, "workload", "port") {
		return
	}
	workload, ok := r.stringParam(id, "service-port", params, "workload")
	if !ok {
		return
	}
	if workload == "" || params["port"] == nil {
		r.fail("resource %q (service-port): params workload and port are required", id)
		return
	}
	var ports map[string]int
	switch {
	case workload == r.name:
		ports = r.ownPorts()
	case r.in.Peers[workload] != nil:
		ports = r.in.Peers[workload]
	}
	n, name, found := portNumber(params["port"], ports)
	if !found {
		if ports == nil {
			r.fail("resource %q (service-port): workload %q is not known here; give params.port as a number", id, workload)
		} else {
			r.fail("resource %q (service-port): workload %q has no port %v", id, workload, params["port"])
		}
		return
	}
	if name == "" && ports != nil {
		known := false
		for _, p := range ports {
			known = known || p == n
		}
		if !known {
			r.fail("resource %q (service-port): workload %q has no port %d", id, workload, n)
			return
		}
	}
	r.outputs[id] = lookupMap(id, map[string]interface{}{"hostname": workload, "port": n})
}

func (r *renderer) volume(id string, params map[string]interface{}) {
	if !r.onlyParams(id, "volume", params, "sizeLimit", "medium") {
		return
	}
	size, ok1 := r.stringParam(id, "volume", params, "sizeLimit")
	medium, ok2 := r.stringParam(id, "volume", params, "medium")
	if !ok1 || !ok2 {
		return
	}
	src := Object{}
	if size != "" {
		src["sizeLimit"] = size
	}
	switch medium {
	case "":
	case "Memory":
		src["medium"] = "Memory"
	default:
		r.fail("resource %q (volume): medium %q is not Memory", id, medium)
		return
	}
	r.volumes[id] = Object{"name": "vol-" + id, "emptyDir": src}
	r.outputs[id] = func(...string) (interface{}, error) {
		return nil, fmt.Errorf("resource %q (volume) is a container volume source, not a value", id)
	}
}

func (r *renderer) secret(id, class string, params map[string]interface{}) {
	if class != "" && class != "default" && class != "external" {
		r.fail("resource %q (secret): class %q is not supported (external)", id, class)
		return
	}
	if !r.onlyParams(id, "secret", params, "key", "properties") {
		return
	}
	key, ok := r.stringParam(id, "secret", params, "key")
	if !ok {
		return
	}
	if key == "" {
		r.fail("resource %q (secret): params.key, the key in the secret store, is required", id)
		return
	}
	props := map[string]string{}
	if raw, present := params["properties"]; present {
		m, isMap := raw.(map[string]interface{})
		if !isMap {
			r.fail("resource %q (secret): params.properties must map output names to store properties", id)
			return
		}
		for k, v := range m {
			s, isString := v.(string)
			if !isString {
				r.fail("resource %q (secret): params.properties.%s must be a string", id, k)
				return
			}
			props[k] = s
		}
	}
	if !r.env.Capabilities.ExternalSecrets {
		r.fail("resource %q (secret): the target cluster of environment %q has no External Secrets; a workload cannot start without its secrets", id, r.env.Name)
		return
	}
	if r.env.SecretStore == nil {
		r.fail("resource %q (secret): environment %q has no secretStore", id, r.env.Name)
		return
	}
	sr := &secretRes{id: id, key: key, properties: props, used: map[string]bool{}}
	r.secrets[id] = sr
	r.outputs[id] = func(keys ...string) (interface{}, error) {
		if len(keys) != 1 || !secretKey.MatchString(keys[0]) {
			return nil, fmt.Errorf("a secret output is ${resources.%s.<key>}", id)
		}
		sr.used[keys[0]] = true
		return secretMarker(id, keys[0]), nil
	}
}

func (r *renderer) serviceAccountResource(id, class string, params map[string]interface{}) {
	if r.sa != nil {
		r.fail("resource %q (service-account): a workload has one service account", id)
		return
	}
	if class == "" || class == "default" {
		class = r.env.ServiceAccountClass
	}
	allowed := []string{"kubeApi"}
	if class == "aws-irsa" {
		allowed = append(allowed, "roleArn")
	}
	if class != "none" && class != "aws-irsa" {
		r.fail("resource %q (service-account): class %q is not supported (none, aws-irsa)", id, class)
		return
	}
	if !r.onlyParams(id, "service-account", params, allowed...) {
		return
	}
	sa := &saRes{class: class}
	if v, present := params["kubeApi"]; present {
		b, isBool := v.(bool)
		if !isBool {
			r.fail("resource %q (service-account): params.kubeApi must be true or false", id)
			return
		}
		sa.kubeAPI = b
	}
	if class == "aws-irsa" {
		arn, ok := r.stringParam(id, "service-account", params, "roleArn")
		if !ok {
			return
		}
		if !roleARN.MatchString(arn) {
			r.fail("resource %q (service-account): params.roleArn %q is not an IAM role ARN", id, arn)
			return
		}
		sa.roleARN = arn
	}
	r.sa = sa
	r.outputs[id] = lookupMap(id, map[string]interface{}{"name": r.name})
}

func (r *renderer) route(id string, params map[string]interface{}) {
	if !r.onlyParams(id, "route", params, "host", "port", "path") {
		return
	}
	host, ok1 := r.stringParam(id, "route", params, "host")
	path, ok2 := r.stringParam(id, "route", params, "path")
	if !ok1 || !ok2 {
		return
	}
	if !hostname.MatchString(host) || len(host) > 253 {
		r.fail("resource %q (route): params.host %q is not a host name", id, host)
		return
	}
	if path == "" {
		path = "/"
	}
	if !routePath.MatchString(path) {
		r.fail("resource %q (route): params.path %q must start with / and not end with one", id, path)
		return
	}
	port, _, found := portNumber(params["port"], r.ownPorts())
	if found {
		found = false
		for _, p := range r.ownPorts() {
			found = found || p == port
		}
	}
	if !found {
		r.fail("resource %q (route): params.port %v is not a port in service.ports", id, params["port"])
		return
	}
	r.outputs[id] = lookupMap(id, map[string]interface{}{"host": host, "path": path})
	if !r.env.Capabilities.GatewayAPI {
		r.note("resource %q (route): no HTTPRoute, the target cluster of environment %q has no Gateway API", id, r.env.Name)
		return
	}
	gw := r.env.Gateway
	if gw == nil {
		r.fail("resource %q (route): environment %q has no gateway to attach the route to", id, r.env.Name)
		return
	}
	parent := Object{"name": gw.Name}
	if gw.Namespace != "" {
		parent["namespace"] = gw.Namespace
	}
	if gw.SectionName != "" {
		parent["sectionName"] = gw.SectionName
	}
	r.add("gateway.networking.k8s.io/v1", "HTTPRoute", r.name+"-"+id, nil, Object{
		"spec": Object{
			"parentRefs": []interface{}{parent},
			"hostnames":  []interface{}{host},
			"rules": []interface{}{Object{
				"matches":     []interface{}{Object{"path": Object{"type": "PathPrefix", "value": path}}},
				"backendRefs": []interface{}{Object{"name": r.name, "port": port}},
			}},
		},
	})
}
