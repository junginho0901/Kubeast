// Package callgraph adds who calls whom to a namespace's Resource Graph (the AI tool resource_graph with include
// calls): the service graph metrics that traces leave in the cluster's Prometheus (Tempo's metrics-generator, the
// OpenTelemetry Collector's and Grafana Alloy's servicegraph connector write the same names) and the Resource Graph's
// traffic lines (nettraffic, from the Hubble metrics). A trace's service name is placed on a workload of the graph by
// the namespace and workload labels when the metric has them, else by the name of a workload, else by a Service's
// selector (the graph's selects edges and owners); one that fits none keeps its service name. From the edges and the
// graph's health it orders the failing workloads so that one whose callees are all well comes first, and draws the
// paths from it to the failing workloads that call it (cause → … → symptom). It builds the PromQL and reads the
// answers; the caller runs the reads as the user.
package callgraph

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netdrops"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/nettraffic"
)

// The service graph metric names (Tempo metrics-generator, OpenTelemetry Collector servicegraph connector).
const (
	RequestsMetric = "traces_service_graph_request_total"
	FailedMetric   = "traces_service_graph_request_failed_total"
	ServerSeconds  = "traces_service_graph_request_server_seconds_bucket"
	// ClientSeconds is read only with features.callGraph.clientLatency.
	ClientSeconds = "traces_service_graph_request_client_seconds_bucket"
)

// connectionLabel says what a service graph series pairs: empty for a client span and its server span, else database,
// virtual_node or messaging_system, whose two sides are not the two ends of one call (a database's server side repeats
// the client span, a virtual node's untraced side is 0, a queue's are the send and the receive).
const connectionLabel = "connection_type"

// Caps of an answer.
const (
	MaxEdges = 100
	// MaxSeries caps the series one trace query brings back (topk), where the metric names no namespace.
	MaxSeries   = 500
	MaxPaths    = 5
	MaxDepth    = 6
	MaxSuspects = 10
	// MaxOutside caps TimeOutsideCallee.
	MaxOutside = 5
)

// A call is named in TimeOutsideCallee when its caller's 90th percentile is at least OutsideRatio times its callee's and
// OutsideMinMs above it. Both are interpolated inside histogram buckets, so two calls a moment apart on either side of a
// bound read about twice each other in Tempo's default buckets, and under 50 ms over four times in the OpenTelemetry connector's.
const (
	OutsideRatio = 3
	OutsideMinMs = 50
)

// Thresholds a call edge counts as failing at: both, so a single error on a quiet edge does not.
const (
	FailingRatio  = 0.05
	FailingErrors = 5
)

// Source names.
const (
	SourceTraces  = "traces"
	SourceNetwork = "network"
)

// Reasons a source was not read.
const (
	ReasonOff              = "off"               // features.callGraph is off in this install
	ReasonNoPrometheus     = "no_prometheus"     // the cluster has no Prometheus
	ReasonNoMetrics        = "no_metrics"        // the metric is not in that Prometheus
	ReasonNamespaceLimited = "namespace_limited" // a grant limited to namespaces reads no Prometheus series of other namespaces
	ReasonPermission       = "permission"        // resource.networkflow.read is not held, as the traffic lines ask
	ReasonFailed           = "failed"            // the read failed (detail says why)
	ReasonNoCalls          = "no_calls"          // ClientP90: the traces count no call in the window, so it was not asked
)

// Unscoped ends a matched_by placed by name where the metric named no namespace for that end: a service of the same
// name in another namespace is counted on this namespace's workload.
const Unscoped = "_unscoped"

// DetailUnscoped is the trace source's detail when the metric has no namespace labels.
const DetailUnscoped = "the metric has no namespace dimension: services are placed by name, and a service of the same name in another namespace counts here (matched_by ends in " + Unscoped + ")"

// DetailNoClientSeconds is ClientP90's detail when its answer held nothing for calls the traces do count.
const DetailNoClientSeconds = "not available: this Prometheus has no " + ClientSeconds + " series for these calls, so no edge has client_p90_ms"

// NoStartCycle: workloads fail but each calls another failing one, so no path has a start.
const NoStartCycle = "cycle"

var nameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// ValidNamespace: a namespace name, the only value the queries take from the request.
func ValidNamespace(ns string) bool { return len(ns) <= 63 && nameRe.MatchString(ns) }

// labelName is an attribute as a metric label: Prometheus' rule, what is not [a-zA-Z0-9_] becomes _.
func labelName(attribute string) string {
	var b strings.Builder
	for _, r := range attribute {
		if r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

// workloadAttributes are the OpenTelemetry resource attributes naming a pod's workload, by the kind they name.
var workloadAttributes = []struct{ attribute, kind string }{
	{"k8s.deployment.name", "Deployment"},
	{"k8s.statefulset.name", "StatefulSet"},
	{"k8s.daemonset.name", "DaemonSet"},
}

// Shape is what the service graph metric's label names allow.
type Shape struct {
	// Namespace: the client_ and server_ labels of the namespace attribute (dimensions added with client/server prefixes).
	Namespace string
	// Workloads: the client_/server_ label suffixes naming a workload, with their kind.
	Workloads map[string]string
	// Connection: the metric has connectionLabel.
	Connection bool
}

// DetectShape reads the metric's label names; ok is false without client and server. namespaceAttribute is the trace
// store's (k8s.namespace.name by default).
func DetectShape(labels []string, namespaceAttribute string) (Shape, bool) {
	has := map[string]bool{}
	for _, l := range labels {
		has[l] = true
	}
	if !has["client"] || !has["server"] {
		return Shape{}, false
	}
	s := Shape{Workloads: map[string]string{}, Connection: has[connectionLabel]}
	if ns := labelName(namespaceAttribute); has["client_"+ns] && has["server_"+ns] {
		s.Namespace = ns
	}
	for _, w := range workloadAttributes {
		if l := labelName(w.attribute); has["client_"+l] && has["server_"+l] {
			s.Workloads[l] = w.kind
		}
	}
	return s, true
}

func (s Shape) by() []string {
	by := []string{"client", "server"}
	if s.Namespace != "" {
		by = append(by, "client_"+s.Namespace, "server_"+s.Namespace)
	}
	names := make([]string, 0, len(s.Workloads))
	for l := range s.Workloads {
		names = append(names, l)
	}
	sort.Strings(names)
	for _, l := range names {
		by = append(by, "client_"+l, "server_"+l)
	}
	return by
}

// Queries are the instant queries of one answer: requests and failed requests over the range, and the server side's
// 90th percentile when the metric has its histogram. ClientP90 is the client side's, by connectionLabel too when the
// metric has it.
type Queries struct {
	Requests, Failed, P90, ClientP90 string
}

// BuildQueries: with the namespace labels, the edges with either end in the namespace (the halves joined with or);
// without them, the busiest MaxSeries edges, placed on the namespace's workloads afterwards, and the 90th percentile of
// the slowest MaxSeries (topk keeps the answer to that many series; Prometheus reads nothing more for it).
func BuildQueries(s Shape, namespace string, rng time.Duration) Queries {
	by := strings.Join(s.by(), ", ")
	secs := int(rng.Seconds())
	sum := func(metric, fn string) string {
		if s.Namespace == "" {
			return fmt.Sprintf("topk(%d, sum by (%s) (%s(%s[%ds])))", MaxSeries, by, fn, metric, secs)
		}
		half := func(end string) string {
			return fmt.Sprintf(`sum by (%s) (%s(%s{%s_%s="%s"}[%ds]))`, by, fn, metric, end, s.Namespace, namespace, secs)
		}
		return half("server") + " or " + half("client")
	}
	q := Queries{Requests: sum(RequestsMetric, "increase"), Failed: sum(FailedMetric, "increase")}
	p90 := func(metric, by string) string {
		bucketBy := "le, " + by
		if s.Namespace == "" {
			return fmt.Sprintf("topk(%d, histogram_quantile(0.9, sum by (%s) (rate(%s[%ds]))))", MaxSeries, bucketBy, metric, secs)
		}
		half := func(end string) string {
			return fmt.Sprintf(`sum by (%s) (rate(%s{%s_%s="%s"}[%ds]))`, bucketBy, metric, end, s.Namespace, namespace, secs)
		}
		return fmt.Sprintf("histogram_quantile(0.9, %s or %s)", half("server"), half("client"))
	}
	q.P90 = p90(ServerSeconds, by)
	if s.Connection {
		by += ", " + connectionLabel
	}
	q.ClientP90 = p90(ClientSeconds, by)
	return q
}

// Sample is one series of an answer.
type Sample struct {
	Labels map[string]string
	Value  float64
}

// Node is a box of the Resource Graph answer, the fields read here.
type Node struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Health    string `json:"health,omitempty"`
	Group     bool   `json:"group,omitempty"`
}

// GraphEdge is a line of the Resource Graph answer.
type GraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}

var workloadKinds = map[string]bool{"Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true, "Pod": true}

// Index places names on the graph's workloads.
type Index struct {
	namespace string
	nodes     map[string]Node
	// top: the workloads owned by nothing in the graph; byName: those by name; byService: those a Service selects.
	top       map[string]bool
	byName    map[string][]string
	byService map[string][]string
	owner     map[string]string
}

// NewIndex reads the nodes and edges of one namespace's graph.
func NewIndex(namespace string, nodes []Node, edges []GraphEdge) *Index {
	ix := &Index{namespace: namespace, nodes: map[string]Node{}, top: map[string]bool{}, byName: map[string][]string{}, byService: map[string][]string{},
		owner: map[string]string{}}
	owner := ix.owner
	selects := map[string][]string{}
	for _, n := range nodes {
		ix.nodes[n.ID] = n
	}
	for _, e := range edges {
		switch e.Type {
		case "owns":
			owner[e.Target] = e.Source
		case "selects":
			selects[e.Source] = append(selects[e.Source], e.Target)
		}
	}
	top := ix.topOf
	ids := make([]string, 0, len(ix.nodes))
	for id := range ix.nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		n := ix.nodes[id]
		if n.Namespace != namespace {
			continue
		}
		if workloadKinds[n.Kind] && !n.Group && top(id) == id {
			ix.top[id] = true
			ix.byName[n.Name] = append(ix.byName[n.Name], id)
		}
		if n.Kind == "Service" {
			seen := map[string]bool{}
			for _, target := range selects[id] {
				if t := top(target); !seen[t] {
					seen[t] = true
					ix.byService[n.Name] = append(ix.byService[n.Name], t)
				}
			}
			sort.Strings(ix.byService[n.Name])
		}
	}
	return ix
}

func (ix *Index) topOf(id string) string {
	for i := 0; i < 5; i++ { // Pod → ReplicaSet → Deployment, Pod → Job → CronJob
		o, ok := ix.owner[id]
		if !ok || !workloadKinds[ix.nodes[o].Kind] {
			return id
		}
		id = o
	}
	return id
}

// WorkloadOf is the graph ID of the workload an object of the namespace belongs to (a Pod's Deployment through its
// ReplicaSet), "" when the object is not on the graph.
func (ix *Index) WorkloadOf(kind, name string) string {
	id := ix.id(kind, name)
	if id == "" || !workloadKinds[kind] {
		return ""
	}
	if t := ix.topOf(id); ix.top[t] {
		return t
	}
	return ""
}

// ServiceWorkload is the graph ID of the workload a trace service name is placed on, as the call edges place it
// without labels (a workload of that name, else the one workload a Service of that name selects); "" when none fits.
func (ix *Index) ServiceWorkload(service string) string {
	if ids := ix.byName[service]; len(ids) == 1 {
		return ids[0]
	}
	if ids := ix.byService[service]; len(ids) == 1 {
		return ids[0]
	}
	return ""
}

// End is one end of a call edge: a box of the graph (ID set), a workload of another namespace, a namespace alone (a
// peer outside the reader's grant, or a pod the source did not name), a trace service that fits no workload, or
// something outside the pods.
type End struct {
	ID        string `json:"id,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Name      string `json:"name,omitempty"`
	// Service: the trace's service name, kept when it fits no workload (no namespace or workload label, no workload
	// or Service of that name in the namespace).
	Service string `json:"service,omitempty"`
	Outside string `json:"outside,omitempty"`
	// Unnamed: the traffic source named no pod at this end.
	Unnamed bool `json:"unnamed,omitempty"`
	// MatchedBy: how a trace service was placed — labels, workload_name, service_selector; with Unscoped after it
	// when the metric named no namespace for this end.
	MatchedBy string `json:"matched_by,omitempty"`
}

func (e End) key() string {
	if e.ID != "" {
		return e.ID
	}
	return e.Namespace + "/" + e.Kind + "/" + e.Name + "/" + e.Service + "/" + e.Outside + fmt.Sprint(e.Unnamed)
}

func (e End) local() bool { return e.ID != "" }

// outsideName names an end that is not a box of the graph: a workload of another namespace, a trace service name
// (a database or another store is one: Tempo names it by db.name or db.system), a namespace alone, or what is not a pod.
func (e End) outsideName() string {
	switch {
	case e.Kind != "" && e.Name != "":
		return e.Kind + "/" + e.Namespace + "/" + e.Name
	case e.Name != "":
		return e.Namespace + "/" + e.Name
	case e.Service != "" && e.Namespace != "":
		return "service " + e.Namespace + "/" + e.Service
	case e.Service != "":
		return "service " + e.Service
	case e.Outside != "":
		return e.Outside
	case e.Namespace != "":
		return "namespace " + e.Namespace
	}
	return "unnamed"
}

// title names an end: a box by its ID.
func (e End) title() string {
	if e.ID != "" {
		return e.ID
	}
	return e.outsideName()
}

// placeService places a trace service name, with the namespace and workload labels when the metric had them. Without a
// namespace for the end, a name is looked up in this namespace only, so matched_by says Unscoped.
func (ix *Index) placeService(service, namespace string, workloads map[string]string) End {
	if namespace != "" && namespace != ix.namespace {
		for _, w := range workloadAttributes {
			if name := workloads[labelName(w.attribute)]; name != "" {
				return End{Namespace: namespace, Kind: w.kind, Name: name, MatchedBy: "labels"}
			}
		}
		return End{Namespace: namespace, Service: service, MatchedBy: "labels"}
	}
	by := func(way string) string {
		if namespace == "" {
			return way + Unscoped
		}
		return way
	}
	for _, w := range workloadAttributes {
		if name := workloads[labelName(w.attribute)]; name != "" {
			if id := ix.id(w.kind, name); id != "" {
				return ix.end(id, by("labels"))
			}
		}
	}
	if ids := ix.byName[service]; len(ids) == 1 {
		return ix.end(ids[0], by("workload_name"))
	}
	if ids := ix.byService[service]; len(ids) == 1 {
		return ix.end(ids[0], by("service_selector"))
	} else if len(ids) > 1 {
		if id := ix.id("Service", service); id != "" {
			return ix.end(id, by("service_selector"))
		}
	}
	return End{Namespace: namespace, Service: service}
}

func (ix *Index) id(kind, name string) string {
	id := kind + "/" + ix.namespace + "/" + name
	if _, ok := ix.nodes[id]; ok {
		return id
	}
	return ""
}

func (ix *Index) end(id, by string) End {
	n := ix.nodes[id]
	return End{ID: id, Namespace: n.Namespace, Kind: n.Kind, Name: n.Name, MatchedBy: by}
}

// placeTraffic places a traffic line's end: a box of the graph when it is one.
func (ix *Index) placeTraffic(e nettraffic.End) End {
	if e.Kind != "" && e.Name != "" {
		if _, ok := ix.nodes[e.Kind+"/"+e.Namespace+"/"+e.Name]; ok && e.Namespace == ix.namespace {
			return ix.end(e.Kind+"/"+e.Namespace+"/"+e.Name, "")
		}
	}
	return End{Namespace: e.Namespace, Kind: e.Kind, Name: e.Name, Outside: e.Outside, Unnamed: e.Unnamed}
}

// Edge is a call from one end to another over the range. Requests, Errors, P90Ms and ClientP90Ms come from the traces;
// Connections (TCP connections opened), Dropped and DropReasons (the traffic lines' reasons, most first) from the
// traffic lines.
type Edge struct {
	From        End               `json:"from"`
	To          End               `json:"to"`
	Sources     []string          `json:"sources"`
	Requests    int64             `json:"requests,omitempty"`
	Errors      int64             `json:"errors,omitempty"`
	ErrorRatio  float64           `json:"error_ratio,omitempty"`
	P90Ms       float64           `json:"p90_ms,omitempty"`
	Connections int64             `json:"connections,omitempty"`
	Dropped     int64             `json:"dropped,omitempty"`
	DropReasons []netdrops.Reason `json:"drop_reasons,omitempty"`
	// ClientP90Ms is the 90th percentile the caller measured, beside P90Ms, the callee's (Traces.ClientP90 read). With
	// ConnectionType (connectionLabel) the two are not two ends of one call.
	ClientP90Ms    float64 `json:"client_p90_ms,omitempty"`
	ConnectionType string  `json:"connection_type,omitempty"`
	// ErrorsUnknown: a series of the edge is not in the failed answer, which came back full (Traces.full), so its
	// failed calls were not read. Errors and ErrorRatio then hold the failed calls read, at most what failed, and the
	// answer gives them as null.
	ErrorsUnknown bool `json:"-"`
}

// MarshalJSON gives errors and error_ratio as null when they are not known, never as 0.
func (e Edge) MarshalJSON() ([]byte, error) {
	type edge Edge
	if !e.ErrorsUnknown {
		return json.Marshal(edge(e))
	}
	return json.Marshal(struct {
		edge
		Errors     *int64   `json:"errors"`
		ErrorRatio *float64 `json:"error_ratio"`
	}{edge: edge(e)})
}

func (e *Edge) weight() int64 { return e.Requests + e.Connections + e.Dropped }

// Failing: calls into To fail often enough to count, or the network drops them.
func (e *Edge) Failing() bool {
	return e.Errors >= FailingErrors && e.ErrorRatio >= FailingRatio || e.Dropped > 0
}

// addClientP90 takes the client side's 90th percentile of one series of the edge: a traced call's before one whose two
// sides are not the two ends of one call, else the slowest.
func (e *Edge) addClientP90(seconds float64, connection string) {
	ms := math.Round(seconds*1000*10) / 10
	if ms <= 0 {
		return
	}
	plain, had := connection == "", e.ClientP90Ms > 0 && e.ConnectionType == ""
	if had && !plain || had == plain && ms <= e.ClientP90Ms {
		return
	}
	e.ClientP90Ms, e.ConnectionType = ms, connection
}

type builder struct {
	edges map[string]*Edge
	order []string
}

func (b *builder) get(from, to End) *Edge {
	k := from.key() + "→" + to.key()
	if e, ok := b.edges[k]; ok {
		return e
	}
	e := &Edge{From: from, To: to}
	b.edges[k] = e
	b.order = append(b.order, k)
	return e
}

// addReasons adds a traffic line's drop reasons to an edge's (two lines may fall on one edge), most first.
func addReasons(have, more []netdrops.Reason) []netdrops.Reason {
	if len(more) == 0 {
		return have
	}
	for _, r := range more {
		i := 0
		for i < len(have) && have[i].Reason != r.Reason {
			i++
		}
		if i == len(have) {
			have = append(have, netdrops.Reason{Reason: r.Reason})
		}
		have[i].Count += r.Count
	}
	sort.SliceStable(have, func(i, j int) bool {
		if have[i].Count != have[j].Count {
			return have[i].Count > have[j].Count
		}
		return have[i].Reason < have[j].Reason
	})
	return have
}

func addSource(e *Edge, source string) {
	for _, s := range e.Sources {
		if s == source {
			return
		}
	}
	e.Sources = append(e.Sources, source)
}

// Traces are the answers of the trace queries.
type Traces struct {
	Shape    Shape
	Requests []Sample
	Failed   []Sample
	P90      []Sample
	// ClientP90 is the client side's, empty when it was not asked (features.callGraph.clientLatency).
	ClientP90 []Sample
}

// full: the answer of a query capped at MaxSeries (no namespace labels) came back with that many series, each above 0,
// so it may have left out series that count (topk keeps the largest: what it left out is at most its smallest).
func (tr *Traces) full(answer []Sample) bool {
	if tr.Shape.Namespace != "" || len(answer) < MaxSeries {
		return false
	}
	for _, s := range answer {
		if s.Value <= 0 {
			return false
		}
	}
	return true
}

// Cut: a capped query came back full, so an edge of the namespace below the busiest MaxSeries may be missing
// (requests), an edge's failed calls may not have been read (failed: its errors are not known) or its 90th percentile (p90).
func (tr *Traces) Cut() bool { return tr.full(tr.Requests) || tr.full(tr.Failed) || tr.full(tr.P90) }

// ClientCut: the client side's answer came back full, so an edge's client_p90_ms may not have been read.
func (tr *Traces) ClientCut() bool { return tr.full(tr.ClientP90) }

// seriesKey names a series by its labels: the three queries sum by the same labels, so an edge's series has one key in each.
func seriesKey(labels map[string]string) string {
	names := make([]string, 0, len(labels))
	for k := range labels {
		names = append(names, k)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, k := range names {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(labels[k])
		b.WriteByte(0)
	}
	return b.String()
}

// Build folds the trace answers and the traffic lines into call edges with an end in the namespace, the busiest first,
// at most MaxEdges (truncated when more, or when the requests answer came back full: an edge below it is not there).
func Build(ix *Index, tr *Traces, traffic []nettraffic.Line) (edges []Edge, total int, truncated bool) {
	b := &builder{edges: map[string]*Edge{}}
	if tr != nil {
		var failedRead map[string]bool
		if tr.full(tr.Failed) {
			failedRead = make(map[string]bool, len(tr.Failed))
			for _, s := range tr.Failed {
				failedRead[seriesKey(s.Labels)] = true
			}
		}
		place := func(l map[string]string) (End, End) {
			ends := [2]End{}
			for i, side := range []string{"client", "server"} {
				ns := ""
				if tr.Shape.Namespace != "" {
					ns = l[side+"_"+tr.Shape.Namespace]
				}
				workloads := map[string]string{}
				for suffix := range tr.Shape.Workloads {
					workloads[suffix] = l[side+"_"+suffix]
				}
				ends[i] = ix.placeService(l[side], ns, workloads)
			}
			return ends[0], ends[1]
		}
		for _, s := range tr.Requests {
			n := int64(math.Round(s.Value))
			if n <= 0 {
				continue
			}
			from, to := place(s.Labels)
			if !from.local() && !to.local() && from.Namespace != ix.namespace && to.Namespace != ix.namespace {
				continue // neither end in the namespace (a metric without namespace labels names every service)
			}
			e := b.get(from, to)
			e.Requests += n
			if failedRead != nil && !failedRead[seriesKey(s.Labels)] {
				e.ErrorsUnknown = true
			}
			addSource(e, SourceTraces)
		}
		for _, s := range tr.Failed {
			from, to := place(s.Labels)
			if e, ok := b.edges[from.key()+"→"+to.key()]; ok {
				e.Errors += int64(math.Round(s.Value))
			}
		}
		for _, s := range tr.P90 {
			if math.IsNaN(s.Value) || math.IsInf(s.Value, 0) {
				continue
			}
			from, to := place(s.Labels)
			if e, ok := b.edges[from.key()+"→"+to.key()]; ok && s.Value*1000 > e.P90Ms {
				e.P90Ms = math.Round(s.Value*1000*10) / 10
			}
		}
		for _, s := range tr.ClientP90 {
			if math.IsNaN(s.Value) || math.IsInf(s.Value, 0) {
				continue
			}
			from, to := place(s.Labels)
			if e, ok := b.edges[from.key()+"→"+to.key()]; ok {
				e.addClientP90(s.Value, s.Labels[connectionLabel])
			}
		}
	}
	for _, l := range traffic {
		from, to := ix.placeTraffic(l.From), ix.placeTraffic(l.To)
		e := b.get(from, to)
		e.Connections += l.Allowed
		e.Dropped += l.Dropped
		e.DropReasons = addReasons(e.DropReasons, l.Reasons)
		addSource(e, SourceNetwork)
	}
	all := make([]*Edge, 0, len(b.order))
	for _, k := range b.order {
		e := b.edges[k]
		if e.Requests > 0 {
			e.ErrorRatio = math.Round(float64(e.Errors)/float64(e.Requests)*1000) / 1000
		}
		if e.weight() > 0 {
			all = append(all, e)
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].weight() != all[j].weight() {
			return all[i].weight() > all[j].weight()
		}
		return all[i].From.key()+"→"+all[i].To.key() < all[j].From.key()+"→"+all[j].To.key()
	})
	total = len(all)
	if truncated = total > MaxEdges; truncated {
		all = all[:MaxEdges]
	}
	if tr != nil && tr.full(tr.Requests) {
		truncated = true
	}
	edges = make([]Edge, 0, len(all))
	for _, e := range all {
		edges = append(edges, *e)
	}
	return edges, total, truncated
}

// Outside is a call whose caller waited much longer than its callee worked (the 90th percentiles of both): that time is
// spent between the two or in the caller.
type Outside struct {
	From        string  `json:"from"`
	To          string  `json:"to"`
	ClientP90Ms float64 `json:"client_p90_ms"`
	P90Ms       float64 `json:"p90_ms"`
	OutsideMs   float64 `json:"outside_ms"`
}

// TimeOutsideCallee lists the edges whose ClientP90Ms is far above their P90Ms (OutsideRatio, OutsideMinMs), the largest
// difference first, at most MaxOutside. An edge with one side not read, or whose sides are not the two ends of one call
// (ConnectionType), is not compared.
func TimeOutsideCallee(edges []Edge) []Outside {
	var out []Outside
	for _, e := range edges {
		if e.P90Ms <= 0 || e.ConnectionType != "" || e.ClientP90Ms < OutsideRatio*e.P90Ms || e.ClientP90Ms-e.P90Ms < OutsideMinMs {
			continue
		}
		out = append(out, Outside{From: e.From.title(), To: e.To.title(), ClientP90Ms: e.ClientP90Ms, P90Ms: e.P90Ms,
			OutsideMs: math.Round((e.ClientP90Ms-e.P90Ms)*10) / 10})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].OutsideMs > out[j].OutsideMs })
	if len(out) > MaxOutside {
		out = out[:MaxOutside]
	}
	return out
}

// Suspect is a failing workload of the graph and where it stands among the calls.
type Suspect struct {
	ID     string `json:"id"`
	Health string `json:"health,omitempty"`
	// Why it counts as failing: health (the graph's colour), calls_fail (calls into it fail), dropped.
	Signals []string `json:"signals"`
	// FailingCallees: the failing workloads it calls. None: nothing it calls is failing — where a failure may start.
	FailingCallees []string `json:"failing_callees,omitempty"`
	// FailingCallers: the failing workloads that call it — they may fail because of it.
	FailingCallers []string `json:"failing_callers,omitempty"`
	// FailingOutside: the ends outside the graph its calls fail to (a database, another namespace, a service name no
	// workload fits, what the network drops) — their health is not known here, so the cause may be there.
	FailingOutside []string `json:"failing_outside,omitempty"`
}

// Ranked is what Suspects finds.
type Ranked struct {
	// Suspects: the first MaxSuspects of Total, in order.
	Suspects []Suspect
	Total    int
	Paths    [][]string
	// NoStart says why there is no path although workloads fail: NoStartCycle when each failing workload calls another.
	NoStart string
}

// Suspects orders the failing workloads of the namespace: those whose callees are all well first (a caller of a failing
// workload is more likely its victim than its cause — the simplest form of what Coroot and Causely do), then by how
// many failing workloads call them; and the paths from each such start to the failing workloads that call it, cause
// first. Only boxes of the graph take part (an edge to another namespace or a service name tells nothing of its health);
// a failing call to such an end is named on its caller (FailingOutside), the order unchanged.
func Suspects(ix *Index, edges []Edge) Ranked {
	signals := map[string][]string{}
	add := func(id, s string) {
		for _, have := range signals[id] {
			if have == s {
				return
			}
		}
		signals[id] = append(signals[id], s)
	}
	for id := range ix.top { // a pod's or ReplicaSet's health is its owner's
		if h := ix.nodes[id].Health; h == "warn" || h == "error" {
			add(id, "health")
		}
	}
	callees := map[string][]string{}
	callers := map[string][]string{}
	outside := map[string][]string{}
	for i := range edges {
		e := &edges[i]
		if !e.To.local() {
			if e.From.local() && e.Failing() {
				outside[e.From.ID] = append(outside[e.From.ID], e.To.outsideName())
			}
			continue
		}
		if e.Errors >= FailingErrors && e.ErrorRatio >= FailingRatio {
			add(e.To.ID, "calls_fail")
		}
		if e.Dropped > 0 {
			add(e.To.ID, "dropped")
		}
		if e.From.local() && e.From.ID != e.To.ID {
			callees[e.From.ID] = append(callees[e.From.ID], e.To.ID)
			callers[e.To.ID] = append(callers[e.To.ID], e.From.ID)
		}
	}
	failing := func(id string) bool { return len(signals[id]) > 0 }
	keep := func(ids []string) []string {
		var out []string
		seen := map[string]bool{}
		for _, id := range ids {
			if failing(id) && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
		sort.Strings(out)
		return out
	}
	names := func(ids []string) []string {
		var out []string
		seen := map[string]bool{}
		for _, id := range ids {
			if !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
		sort.Strings(out)
		return out
	}
	var out []Suspect
	for id := range signals {
		out = append(out, Suspect{ID: id, Health: ix.nodes[id].Health, Signals: signals[id], FailingCallees: keep(callees[id]),
			FailingCallers: keep(callers[id]), FailingOutside: names(outside[id])})
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (len(a.FailingCallees) == 0) != (len(b.FailingCallees) == 0) {
			return len(a.FailingCallees) == 0
		}
		if len(a.FailingCallers) != len(b.FailingCallers) {
			return len(a.FailingCallers) > len(b.FailingCallers)
		}
		return a.ID < b.ID
	})
	// paths: from each start up through its failing callers, depth first, no workload twice in a path
	var paths [][]string
	var walk func(path []string)
	walk = func(path []string) {
		if len(paths) >= MaxPaths {
			return
		}
		last := path[len(path)-1]
		var next []string
		for _, c := range keep(callers[last]) {
			if !contains(path, c) {
				next = append(next, c)
			}
		}
		if len(next) == 0 || len(path) >= MaxDepth {
			if len(path) > 1 {
				paths = append(paths, append([]string{}, path...))
			}
			return
		}
		for _, c := range next {
			walk(append(path, c))
		}
	}
	for _, s := range out {
		if len(s.FailingCallees) == 0 {
			walk([]string{s.ID})
		}
	}
	r := Ranked{Suspects: out, Total: len(out), Paths: paths}
	if len(out) > 0 && len(out[0].FailingCallees) > 0 { // the starts come first: none
		r.NoStart = NoStartCycle
	}
	if len(r.Suspects) > MaxSuspects {
		r.Suspects = r.Suspects[:MaxSuspects]
	}
	return r
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// SourceState says whether a source was read and, when not, why.
type SourceState struct {
	Source string `json:"source"`
	Read   bool   `json:"read"`
	Reason string `json:"reason,omitempty"`
	// Detail: why the read failed, or beside a read what limits it (DetailUnscoped).
	Detail string `json:"detail,omitempty"`
	// Series: the trace queries' series, or the traffic lines, read.
	Series int `json:"series,omitempty"`
	// Truncated: a trace query capped at MaxSeries came back full (Traces.Cut): an edge of the namespace may be
	// missing (the answer's truncated too), an edge's errors not known (null) or its p90_ms not read.
	Truncated bool `json:"truncated,omitempty"`
	// ClientP90: what came of the client side's 90th percentile (the traces read, features.callGraph.clientLatency on).
	ClientP90 *ClientP90 `json:"client_p90,omitempty"`
}

// ClientP90 says whether the client side's 90th percentile was read and, when not, why. Not read is no failure of the
// traces: the rest of the answer stays.
type ClientP90 struct {
	Read      bool   `json:"read"`
	Reason    string `json:"reason,omitempty"`
	Detail    string `json:"detail,omitempty"`
	Series    int    `json:"series,omitempty"`
	Truncated bool   `json:"truncated,omitempty"` // Traces.ClientCut
}

// Result is the calls part of a graph answer. Suspects and Paths come before the edges, so a cut answer keeps them.
type Result struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	Range     string `json:"range,omitempty"`
	// Window: the fixed window read (start and end asked), the range ending at its end; without it the range ends now.
	Window  *Window       `json:"window,omitempty"`
	Sources []SourceState `json:"sources"`
	// Paths: cause → … → symptom, each a list of graph IDs (the first calls nothing failing, each next one calls the one before).
	Paths [][]string `json:"paths"`
	// NoStart: why Paths is empty although workloads fail (NoStartCycle).
	NoStart  string    `json:"no_start,omitempty"`
	Suspects []Suspect `json:"suspects"`
	// SuspectsTotal: the failing workloads before Suspects' cap (MaxSuspects).
	SuspectsTotal int    `json:"suspects_total,omitempty"`
	EdgesTotal    int    `json:"edges_total"`
	Truncated     bool   `json:"truncated,omitempty"`
	Edges         []Edge `json:"edges"`
	// TimeOutsideCallee: the edges whose caller waited much longer than its callee worked (nothing without ClientP90Ms).
	TimeOutsideCallee []Outside `json:"time_outside_callee,omitempty"`
}

// Window is a fixed window as RFC3339 times.
type Window struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// Off is the answer of an install with features.callGraph off: nothing read.
func Off() Result {
	return Result{Reason: ReasonOff, Sources: []SourceState{}, Paths: [][]string{}, Suspects: []Suspect{}, Edges: []Edge{}}
}
