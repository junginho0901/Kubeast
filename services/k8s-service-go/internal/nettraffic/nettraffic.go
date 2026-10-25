// Package nettraffic turns network traffic into the lines of the Resource Graph: who talks to whom among
// the workloads of some namespaces. Two sources: the recent flows of the cluster's Hubble Relay (the
// connections netflows folds them into), or the Hubble metrics in the cluster's Prometheus — TCP
// connections opened (hubble_tcp_flags_total, flag SYN) and dropped packets (hubble_drop_total).
// It builds the PromQL and reads the answers; the caller runs the reads as the user.
package nettraffic

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
)

// TCPMetric counts TCP flags; a SYN without ACK is the client opening a connection, so the source and
// destination labels point the way the connection goes. hubble_flows_processed_total is not used: it
// counts the replies too, with no label to tell them, so every connection would also draw a line back.
const TCPMetric = "hubble_tcp_flags_total"

// Notes the screen explains.
const (
	NoteNoTCPMetric  = "no_tcp_metric"  // only drops: the TCP flag metric is missing or has no context labels
	NoteNoDropMetric = "no_drop_metric" // only connections: the drop metric is missing or has no context labels
	// NoteCountedTwice: without traffic_direction a connection seen at both ends is counted at each.
	NoteCountedTwice = "counted_at_both_ends"
	// NotePodsOnlyNoOutside: metrics that name pods only (Retina) leave the destination of a connection to a
	// Service unnamed where it leaves the client, as for one leaving the pods; those are not drawn.
	NotePodsOnlyNoOutside = "pods_only_no_outside"
)

// Caps of an answer.
const (
	MaxNamespaces  = 20
	MaxLines       = 300
	MaxPorts       = 10
	MaxConnections = 10
)

var (
	ErrInvalidRequest = errors.New("invalid network traffic request")
	nameRe            = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
)

// ParseNamespaces reads "a,b": 1 to MaxNamespaces namespace names, each once, in the order given.
func ParseNamespaces(s string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	for _, ns := range strings.Split(s, ",") {
		ns = strings.TrimSpace(ns)
		if ns == "" || seen[ns] {
			continue
		}
		if !nameRe.MatchString(ns) || len(ns) > 63 {
			return nil, fmt.Errorf("%w: namespace %q", ErrInvalidRequest, ns)
		}
		seen[ns] = true
		out = append(out, ns)
	}
	if len(out) == 0 || len(out) > MaxNamespaces {
		return nil, fmt.Errorf("%w: 1 to %d namespaces", ErrInvalidRequest, MaxNamespaces)
	}
	return out, nil
}

// End is one end of a line: a workload or pod (Kind and Name; Kind is empty when the metric named it by a
// single "namespace/name" that may be either), a namespace alone (a peer outside the reader's namespaces,
// or a pod the source did not name), or something that is not a pod (Outside).
type End struct {
	Namespace string `json:"namespace,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Name      string `json:"name,omitempty"`
	// Outside: world, host, kube-apiserver, remote-node, ingress, health…, the DNS name of a world
	// address, or unknown when the source did not say.
	Outside string `json:"outside,omitempty"`
}

func (e End) key() string { return e.Namespace + "/" + e.Kind + "/" + e.Name + "/" + e.Outside }

// Port is a destination port of a line.
type Port struct {
	Protocol string `json:"protocol,omitempty"`
	Port     uint32 `json:"port,omitempty"`
	// Allowed and Dropped are the line's counts to this port.
	Allowed int64 `json:"allowed"`
	Dropped int64 `json:"dropped"`
}

type portKey struct {
	protocol string
	port     uint32
}

// Line is the traffic from one end to another. Allowed and Dropped count flows (source relay: every flow
// Hubble reported for the connections, both ways and at each end it was seen) or, for source metrics, TCP
// connections opened and packets dropped.
type Line struct {
	From     End                  `json:"from"`
	To       End                  `json:"to"`
	Allowed  int64                `json:"allowed"`
	Dropped  int64                `json:"dropped"`
	Ports    []Port               `json:"ports,omitempty"`
	Reasons  []netdrops.Reason    `json:"reasons,omitempty"`
	DeniedBy []netflows.PolicyRef `json:"denied_by,omitempty"`
	Last     *time.Time           `json:"last,omitempty"`
	// Connections are the most recent connections behind the line (source relay).
	Connections []netflows.Group `json:"connections,omitempty"`
}

// Result is the answer. Lines are the busiest first.
type Result struct {
	Available  bool     `json:"available"`
	Reason     string   `json:"reason,omitempty"` // why not available
	Source     string   `json:"source"`           // relay or metrics
	Style      string   `json:"style,omitempty"`  // metrics: labels or pod
	Namespaces []string `json:"namespaces"`
	Since      string   `json:"since,omitempty"` // relay
	Range      string   `json:"range,omitempty"` // metrics
	Lines      []Line   `json:"lines"`
	// LinesTruncated: more than MaxLines; the quietest were left out.
	LinesTruncated bool `json:"lines_truncated,omitempty"`
	// Flows read from the Relay, and Truncated when it returned as many as asked (so there may be more).
	Flows     int      `json:"flows,omitempty"`
	Truncated bool     `json:"truncated,omitempty"`
	Lost      uint64   `json:"lost_events,omitempty"`
	Redacted  bool     `json:"redacted,omitempty"`
	Notes     []string `json:"notes,omitempty"`
	Cluster   string   `json:"cluster,omitempty"`
	Mode      string   `json:"mode,omitempty"`
	Relay     string   `json:"relay,omitempty"`
	// Provider is what served the recent flows: hubble or calico.
	Provider string `json:"provider,omitempty"`
}

// reserved names Cilium's reserved identities (pkg/identity/numericidentity.go), stable numbers.
var reserved = map[uint32]string{1: "host", 2: "world", 3: "unmanaged", 4: "health", 5: "init", 6: "remote-node",
	7: "kube-apiserver", 8: "ingress", 9: "world", 10: "world"}

// flowEnd is a connection end as a line end: the workload of a pod when Hubble named it, else the pod.
func flowEnd(e netflows.End, names map[string]string) End {
	switch {
	case e.Namespace != "" && e.Workload != nil && e.Workload.Name != "":
		return End{Namespace: e.Namespace, Kind: e.Workload.Kind, Name: e.Workload.Name}
	case e.Namespace != "" && e.Pod != "":
		return End{Namespace: e.Namespace, Kind: "Pod", Name: e.Pod}
	case e.Namespace != "":
		return End{Namespace: e.Namespace}
	case e.IP == "" && len(e.Names) > 0: // named without an address: Calico's "public network", "private network"
		return End{Outside: e.Names[0]}
	}
	out := reserved[e.Identity]
	if out == "world" || out == "" {
		if n := names[e.IP]; n != "" {
			return End{Outside: n}
		}
	}
	if out == "" {
		out = "unknown"
	}
	return End{Outside: out}
}

type line struct {
	Line
	ports   map[portKey]*Port
	reasons map[string]int64
	denied  map[netflows.PolicyRef]bool
}

func (l *line) total() int64 { return l.Allowed + l.Dropped }

// FromFlows makes the lines of a Relay answer: each connection netflows folded the flows into adds its
// flows to the line between its ends' workloads. A forwarded connection counts as allowed where it arrived:
// seen at the destination's ingress, answered, or going outside the pods. One seen only leaving towards a pod
// is on its way or dropped further on, where the drop is a connection of its own (Hubble verdicts are per
// observation point: a packet NetworkPolicy drops at the destination is FORWARDED at the source's egress).
func FromFlows(res *netflows.Result, namespaces []string) Result {
	// DNS names of world addresses, from the flows (the connections drop them)
	names := map[string]string{}
	for _, f := range res.Flows {
		for _, e := range []netflows.End{f.Source, f.Destination} {
			if e.IP != "" && len(e.Names) > 0 && names[e.IP] == "" {
				names[e.IP] = e.Names[0]
			}
		}
	}
	lines := map[string]*line{}
	var order []string
	for _, g := range res.Groups {
		if g.Destination.ServiceAddress && g.Verdict != "DROPPED" {
			continue // seen before the Service sent it on: counted where it arrives
		}
		from, to := flowEnd(g.Source, names), flowEnd(g.Destination, names)
		k := from.key() + "→" + to.key()
		l, ok := lines[k]
		if !ok {
			l = &line{Line: Line{From: from, To: to}, ports: map[portKey]*Port{}, reasons: map[string]int64{}, denied: map[netflows.PolicyRef]bool{}}
			lines[k] = l
			order = append(order, k)
		}
		n := int64(g.Count + g.Replies)
		port := &Port{}
		if g.Destination.Port != 0 || g.Protocol != "" {
			k := portKey{g.Protocol, g.Destination.Port}
			if l.ports[k] == nil {
				l.ports[k] = &Port{Protocol: g.Protocol, Port: g.Destination.Port}
			}
			port = l.ports[k]
		}
		switch {
		case g.Verdict == "DROPPED":
			l.Dropped += n
			port.Dropped += n
			if g.DropReason != "" {
				l.reasons[g.DropReason] += n
			}
		case g.Replies > 0 || to.Outside != "" || slices.Contains(g.Observed, "ingress"):
			l.Allowed += n
			port.Allowed += n
		}
		if g.Policies != nil {
			for _, p := range append(append([]netflows.PolicyRef{}, g.Policies.EgressDeniedBy...), g.Policies.IngressDeniedBy...) {
				l.denied[p] = true
			}
		}
		if l.Last == nil || g.Last.After(*l.Last) {
			last := g.Last
			l.Last = &last
		}
		if len(l.Connections) < MaxConnections { // the groups come newest first
			l.Connections = append(l.Connections, g)
		}
	}
	out := Result{Available: true, Source: "relay", Namespaces: namespaces, Since: res.Since, Flows: len(res.Flows),
		Truncated: res.Truncated, Lost: res.Lost, Redacted: res.Redacted, Cluster: res.Cluster, Mode: res.Mode, Relay: res.Relay, Provider: res.Provider}
	all := make([]*line, 0, len(order))
	for _, k := range order {
		if lines[k].total() > 0 {
			all = append(all, lines[k])
		}
	}
	out.Lines, out.LinesTruncated = finish(all)
	return out
}

// finish fills each line's lists, sorts the lines busiest first and caps them.
func finish(all []*line) ([]Line, bool) {
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].total() != all[j].total() {
			return all[i].total() > all[j].total()
		}
		return all[i].From.key()+"→"+all[i].To.key() < all[j].From.key()+"→"+all[j].To.key()
	})
	truncated := len(all) > MaxLines
	if truncated {
		all = all[:MaxLines]
	}
	out := make([]Line, 0, len(all))
	for _, l := range all {
		for _, p := range l.ports {
			if p.Allowed+p.Dropped > 0 {
				l.Ports = append(l.Ports, *p)
			}
		}
		byPort := func(i, j int) bool {
			if l.Ports[i].Port != l.Ports[j].Port {
				return l.Ports[i].Port < l.Ports[j].Port
			}
			return l.Ports[i].Protocol < l.Ports[j].Protocol
		}
		// the busiest MaxPorts, listed by port
		sort.Slice(l.Ports, func(i, j int) bool {
			if a, b := l.Ports[i].Allowed+l.Ports[i].Dropped, l.Ports[j].Allowed+l.Ports[j].Dropped; a != b {
				return a > b
			}
			return byPort(i, j)
		})
		if len(l.Ports) > MaxPorts {
			l.Ports = l.Ports[:MaxPorts]
		}
		sort.Slice(l.Ports, byPort)
		for r, n := range l.reasons {
			l.Reasons = append(l.Reasons, netdrops.Reason{Reason: r, Count: n})
		}
		sort.Slice(l.Reasons, func(i, j int) bool {
			if l.Reasons[i].Count != l.Reasons[j].Count {
				return l.Reasons[i].Count > l.Reasons[j].Count
			}
			return l.Reasons[i].Reason < l.Reasons[j].Reason
		})
		for p := range l.denied {
			l.DeniedBy = append(l.DeniedBy, p)
		}
		sort.Slice(l.DeniedBy, func(i, j int) bool {
			a, b := l.DeniedBy[i], l.DeniedBy[j]
			return a.Kind+"/"+a.Namespace+"/"+a.Name < b.Kind+"/"+b.Namespace+"/"+b.Name
		})
		out = append(out, l.Line)
	}
	return out, truncated
}

// Shape is what a metric's label names allow: netdrops' two styles, and whether the observing side is told.
type Shape struct {
	netdrops.Shape
	Direction bool // traffic_direction
	// NoWorkload: the ends are named by namespace and pod only (Retina's flows carry no workload, so its
	// workload labels stay empty); the pods' workloads are looked up.
	NoWorkload bool
}

// DetectShape reads a metric's label names; ok is false when the ends are not named.
func DetectShape(labels []string) (Shape, bool) {
	has := map[string]bool{}
	for _, l := range labels {
		has[l] = true
	}
	s, ok := netdrops.DetectShape(labels)
	noWorkload := false
	if !ok && has["source_namespace"] && has["destination_namespace"] && has["source_pod"] && has["destination_pod"] {
		s, ok, noWorkload = netdrops.Shape{Style: netdrops.StyleLabels, Pod: true}, true, true
	}
	if !ok {
		return Shape{}, false
	}
	return Shape{Shape: s, Direction: has["traffic_direction"], NoWorkload: noWorkload}, true
}

// Query builds the query of a metric over the namespaces: either end in one of them (the two halves joined
// with or, which keeps a series once), summed by the ends' labels — and by reason for the drop metric,
// by traffic_direction when the metric has it.
func Query(metric string, shape Shape, namespaces []string, rng time.Duration) string {
	quoted := make([]string, len(namespaces))
	for i, ns := range namespaces {
		quoted[i] = regexp.QuoteMeta(ns)
	}
	set := strings.Join(quoted, "|")
	var by []string
	var src, dst string
	if shape.Style == netdrops.StylePod {
		by = []string{"source", "destination"}
		src, dst = `source=~"(`+set+`)/.+"`, `destination=~"(`+set+`)/.+"`
	} else {
		for _, end := range []string{"source", "destination"} {
			by = append(by, end+"_namespace")
			if !shape.NoWorkload {
				by = append(by, end+"_workload")
			}
			if shape.Kind {
				by = append(by, end+"_workload_kind")
			}
			if shape.Pod {
				by = append(by, end+"_pod")
			}
		}
		src, dst = `source_namespace=~"`+set+`"`, `destination_namespace=~"`+set+`"`
	}
	if shape.Direction {
		by = append(by, "traffic_direction")
	}
	var sel []string
	if metric == TCPMetric {
		sel = []string{`flag="SYN"`}
	} else {
		by = append(by, "reason")
	}
	half := func(m string) string {
		return fmt.Sprintf("sum by (%s) (increase(%s{%s}[%ds]))", strings.Join(by, ", "), metric, strings.Join(append(append([]string{}, sel...), m), ", "), int(rng.Seconds()))
	}
	return half(src) + " or " + half(dst)
}

// metricEnd is an end as a metric names it.
func metricEnd(shape Shape, end string, l map[string]string) End {
	if shape.Style == netdrops.StylePod {
		v := l[end]
		if i := strings.Index(v, "/"); i > 0 && i < len(v)-1 {
			return End{Namespace: v[:i], Name: v[i+1:]}
		}
		return End{Outside: "unknown"}
	}
	ns, w, kind, pod := l[end+"_namespace"], l[end+"_workload"], l[end+"_workload_kind"], l[end+"_pod"]
	switch {
	case ns != "" && w != "":
		return End{Namespace: ns, Kind: kind, Name: w}
	case ns != "" && pod != "":
		return End{Namespace: ns, Kind: "Pod", Name: pod}
	case ns != "":
		return End{Namespace: ns}
	}
	return End{Outside: "unknown"}
}

// hide keeps only the namespace of an end outside the reader's namespaces; true when it did.
func hide(e *End, scope []string) bool {
	if scope == nil || e.Namespace == "" {
		return false
	}
	for _, ns := range scope {
		if ns == e.Namespace {
			return false
		}
	}
	changed := e.Kind != "" || e.Name != ""
	e.Kind, e.Name = "", ""
	return changed
}

// Sample is one series of an answer.
type Sample = netdrops.Sample

// FromMetrics makes the lines of the two metrics' answers (either may be absent: shape ok false). With
// traffic_direction a connection is counted where it arrived — the SYNs seen at a pod's ingress, or leaving
// towards an address outside the pods — so a SYN NetworkPolicy drops at the destination (FORWARDED at the
// source's egress) is not counted as opened. Without it, both sides add up. owners (nil: none) names the
// workload of a pod end, for metrics that name pods only.
func FromMetrics(tcp Shape, tcpOK bool, tcpRows []Sample, drop Shape, dropOK bool, dropRows []Sample, namespaces, scope []string, rng time.Duration, owners func(namespace, pod string) *netflows.Workload) Result {
	out := Result{Available: true, Source: "metrics", Namespaces: namespaces, Range: rng.String()}
	if tcpOK {
		out.Style = tcp.Style
		if !tcp.Direction {
			out.Notes = append(out.Notes, NoteCountedTwice)
		}
	} else {
		out.Style = drop.Style
		out.Notes = append(out.Notes, NoteNoTCPMetric)
	}
	if !dropOK {
		out.Notes = append(out.Notes, NoteNoDropMetric)
	}
	lines := map[string]*line{}
	get := func(from, to End) *line {
		for _, e := range []*End{&from, &to} {
			if owners == nil || e.Kind != "Pod" {
				continue
			}
			if w := owners(e.Namespace, e.Name); w != nil {
				e.Kind, e.Name = w.Kind, w.Name
			}
		}
		if hide(&from, scope) {
			out.Redacted = true
		}
		if hide(&to, scope) {
			out.Redacted = true
		}
		k := from.key() + "→" + to.key()
		l, ok := lines[k]
		if !ok {
			l = &line{Line: Line{From: from, To: to}, reasons: map[string]int64{}}
			lines[k] = l
		}
		return l
	}
	// connections opened, by line and observing side
	opened := map[*line]map[string]int64{}
	unnamed := false
	for _, s := range tcpRows {
		n := int64(math.Round(s.Value))
		if n <= 0 {
			continue
		}
		to := metricEnd(tcp, "destination", s.Labels)
		if tcp.NoWorkload && to.Outside != "" {
			unnamed = true
			continue
		}
		l := get(metricEnd(tcp, "source", s.Labels), to)
		if opened[l] == nil {
			opened[l] = map[string]int64{}
		}
		opened[l][s.Labels["traffic_direction"]] += n
	}
	if unnamed {
		out.Notes = append(out.Notes, NotePodsOnlyNoOutside)
	}
	for l, bySide := range opened {
		switch {
		case !tcp.Direction:
			for _, n := range bySide {
				l.Allowed += n
			}
		case l.To.Outside != "":
			l.Allowed = bySide["egress"]
		default:
			l.Allowed = bySide["ingress"]
		}
	}
	for _, s := range dropRows {
		n := int64(math.Round(s.Value))
		if n <= 0 {
			continue
		}
		l := get(metricEnd(drop, "source", s.Labels), metricEnd(drop, "destination", s.Labels))
		l.Dropped += n
		l.reasons[s.Labels["reason"]] += n
	}
	all := make([]*line, 0, len(lines))
	for _, l := range lines {
		if l.total() > 0 {
			all = append(all, l)
		}
	}
	out.Lines, out.LinesTruncated = finish(all)
	return out
}
