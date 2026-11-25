package nodecpu

import (
	"regexp"
	"sort"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/util/validation"
)

// Pod is a pod on the node the caller may list.
type Pod struct {
	Namespace  string
	Name       string
	Owner      string // Kind/name of its controller, "" without one or where it is no such names
	Containers map[string]Container
}

// Container is what a pod row says of one container. Known is false where the row does not say its resources (an init
// container), so "no limit" is not read from it.
type Container struct {
	Known     bool
	Request   string // the CPU request as written, "" for none
	Limit     string
	StartedAt time.Time // zero while it is not running
}

// PodsFromRows reads the pods of a node from their rows (podrow.Info), which hold no environment value and no Secret.
func PodsFromRows(rows []map[string]interface{}) []Pod {
	pods := make([]Pod, 0, len(rows))
	for _, row := range rows {
		p := Pod{Namespace: str(row, "namespace"), Name: str(row, "name"), Containers: map[string]Container{}}
		if p.Namespace == "" || p.Name == "" {
			continue
		}
		for _, o := range list(row, "owner_references") {
			if controller, _ := o["controller"].(bool); controller || p.Owner == "" {
				p.Owner = ownerName(str(o, "kind"), str(o, "name"))
			}
		}
		for _, c := range list(row, "containers") {
			resources := object(c, "resources")
			p.Containers[str(c, "name")] = Container{Known: true, Request: quantity(resources, "requests"), Limit: quantity(resources, "limits"), StartedAt: startedAt(c)}
		}
		for _, c := range list(row, "init_containers") {
			p.Containers[str(c, "name")] = Container{StartedAt: startedAt(c)}
		}
		pods = append(pods, p)
	}
	return pods
}

var kindRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,62}$`)

// ownerName is Kind/name of an owner reference, "" when it is not a kind's and an object's name: the API server takes any
// text there, and the answer's sentences name the owner.
func ownerName(kind, name string) string {
	if !kindRe.MatchString(kind) || len(validation.IsDNS1123Subdomain(name)) > 0 {
		return ""
	}
	return kind + "/" + name
}

// startedLast is when the last of p's running containers started, zero without one.
func (p Pod) startedLast() time.Time {
	var last time.Time
	for _, c := range p.Containers {
		if c.StartedAt.After(last) {
			last = c.StartedAt
		}
	}
	return last
}

func startedAt(container map[string]interface{}) time.Time {
	t, err := time.Parse(time.RFC3339, str(object(object(container, "state"), "running"), "started_at"))
	if err != nil {
		return time.Time{}
	}
	return t
}

// quantity is the CPU of a container's requests or limits as the row writes it.
func quantity(resources map[string]interface{}, key string) string {
	switch v := resources[key].(type) {
	case map[string]string:
		return v["cpu"]
	case map[string]interface{}:
		return str(v, "cpu")
	}
	return ""
}

// Cores reads a CPU quantity ("250m", "1", "12345n") as cores; ok is false for what is not one.
func Cores(quantity string) (cores float64, ok bool) {
	if strings.TrimSpace(quantity) == "" {
		return 0, false
	}
	q, err := resource.ParseQuantity(strings.TrimSpace(quantity))
	if err != nil {
		return 0, false
	}
	return q.AsApproximateFloat64(), true
}

// CurrentFromRows is the metrics API's current cores of the containers of pods, from its pod rows; a row of a pod that is
// not in pods is left out.
func CurrentFromRows(pods []Pod, rows []map[string]interface{}) map[Key]float64 {
	on := map[[2]string]bool{}
	for _, p := range pods {
		on[[2]string{p.Namespace, p.Name}] = true
	}
	out := map[Key]float64{}
	for _, row := range rows {
		ns, name := str(row, "namespace"), str(row, "name")
		if !on[[2]string{ns, name}] {
			continue
		}
		for _, c := range list(row, "containers") {
			k := Key{ns, name, str(c, "name")}
			if cores, ok := Cores(str(c, "cpu")); ok && k.names() {
				out[k] = cores
			}
		}
	}
	return out
}

// Namespaces are the namespaces of pods, those with the most pods first.
func Namespaces(pods []Pod) []string {
	count := map[string]int{}
	for _, p := range pods {
		count[p.Namespace]++
	}
	out := make([]string, 0, len(count))
	for ns := range count {
		out = append(out, ns)
	}
	sort.Slice(out, func(i, j int) bool {
		if count[out[i]] != count[out[j]] {
			return count[out[i]] > count[out[j]]
		}
		return out[i] < out[j]
	})
	return out
}

func str(m map[string]interface{}, key string) string {
	s, _ := m[key].(string)
	return s
}

func object(m map[string]interface{}, key string) map[string]interface{} {
	v, _ := m[key].(map[string]interface{})
	return v
}

func list(m map[string]interface{}, key string) []map[string]interface{} {
	switch v := m[key].(type) {
	case []map[string]interface{}:
		return v
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(v))
		for _, item := range v {
			if o, ok := item.(map[string]interface{}); ok {
				out = append(out, o)
			}
		}
		return out
	}
	return nil
}
