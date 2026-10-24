// Package netdrops turns the Hubble drop metric (hubble_drop_total, from Cilium or Microsoft Retina's
// Hubble control plane) into the drops of a namespace, pod or workload: how many, why, and from or to
// whom. It builds the PromQL and reads the answer; the caller runs the queries as the user.
package netdrops

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Metric is the Hubble drop counter: labels reason, protocol and the context labels the agent adds.
const Metric = "hubble_drop_total"

// The two ways the agent can name the ends of a drop.
const (
	// StyleLabels: labelsContext — source_namespace, source_workload, source_workload_kind, source_pod
	// and the destination_* twins, each its own label.
	StyleLabels = "labels"
	// StylePod: sourceContext/destinationContext=pod — one label per end, "<namespace>/<pod>"
	// (Retina's Hubble control plane writes only the end on the pod's own side).
	StylePod = "pod"
)

// Notes the screen and the AI explain.
const (
	NoteWorkloadLevel = "workload_level" // a pod's drops are its workload's: the metric has no pod label
	NoteNoWorkload    = "no_workload"    // a pod without a workload cannot be told apart in the metric
	NotePodsTruncated = "pods_truncated" // more pods than are named in the query
)

// MaxPods caps the pod names put in one query (pod style).
const MaxPods = 50

var (
	ErrInvalidRequest = errors.New("invalid network drops request")
	nameRe            = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
)

// Kinds a request can name, besides the whole namespace.
var Kinds = map[string]bool{"Pod": true, "Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true}

// Shape is what the metric's label names allow.
type Shape struct {
	Style string
	Pod   bool // labels style with source_pod and destination_pod
	Kind  bool // labels style with the workload kinds
}

// DetectShape reads the label names the metric has. ok is false when it has neither style's labels.
func DetectShape(labels []string) (Shape, bool) {
	has := map[string]bool{}
	for _, l := range labels {
		has[l] = true
	}
	switch {
	case has["source_namespace"] && has["destination_namespace"] && has["source_workload"] && has["destination_workload"]:
		return Shape{Style: StyleLabels, Pod: has["source_pod"] && has["destination_pod"],
			Kind: has["source_workload_kind"] && has["destination_workload_kind"]}, true
	case has["source"] || has["destination"]:
		return Shape{Style: StylePod}, true
	}
	return Shape{}, false
}

// Workload names a pod's owner the way the agent does (Deployment for a ReplicaSet's pods, CronJob for a Job's).
type Workload struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// Request is what to read.
type Request struct {
	Namespace string
	Kind      string // "" for the whole namespace
	Name      string
	Range     time.Duration
	// Workload is the target's workload as the agent names it: the owner of a Pod or ReplicaSet or Job,
	// or the target itself. Nil for a pod without one.
	Workload *Workload
	// Pods are the target's current pods (pod style), at most MaxPods.
	Pods          []string
	PodsTruncated bool
	// Scope is a namespace-scoped reader's namespaces (nil = the whole cluster).
	Scope []string
}

// ParseRange accepts a Go duration between one minute and a day; empty is an hour.
func ParseRange(s string) (time.Duration, error) {
	if s == "" {
		return time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < time.Minute || d > 24*time.Hour {
		return 0, fmt.Errorf("%w: range must be between 1m and 24h", ErrInvalidRequest)
	}
	return d, nil
}

// Validate checks the names before any of them reaches a query.
func (r Request) Validate() error {
	if !nameRe.MatchString(r.Namespace) {
		return fmt.Errorf("%w: namespace %q", ErrInvalidRequest, r.Namespace)
	}
	if (r.Kind == "") != (r.Name == "") {
		return fmt.Errorf("%w: kind and name go together", ErrInvalidRequest)
	}
	if r.Kind != "" && (!Kinds[r.Kind] || !nameRe.MatchString(r.Name)) {
		return fmt.Errorf("%w: kind %q name %q (Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob)", ErrInvalidRequest, r.Kind, r.Name)
	}
	return nil
}

// Query is one PromQL instant query and the side it reads.
type Query struct {
	Side string // incoming (the target is the destination) or outgoing (the target is the source)
	Expr string
}

// Plan builds the queries for the request; none when the metric cannot single the target out, with the note why.
func Plan(shape Shape, r Request) ([]Query, []string) {
	var notes []string
	var in, out []string // matchers on the target's side
	inPeer, outPeer := peerLabels(shape, "source"), peerLabels(shape, "destination")
	switch shape.Style {
	case StyleLabels:
		in, out = []string{matcher("destination_namespace", r.Namespace)}, []string{matcher("source_namespace", r.Namespace)}
		switch {
		case r.Kind == "":
		case r.Kind == "Pod" && shape.Pod:
			in, out = append(in, matcher("destination_pod", r.Name)), append(out, matcher("source_pod", r.Name))
		case r.Workload == nil:
			return nil, []string{NoteNoWorkload}
		default:
			if r.Kind == "Pod" {
				notes = append(notes, NoteWorkloadLevel)
			}
			in, out = append(in, matcher("destination_workload", r.Workload.Name)), append(out, matcher("source_workload", r.Workload.Name))
			if shape.Kind {
				in, out = append(in, matcher("destination_workload_kind", r.Workload.Kind)), append(out, matcher("source_workload_kind", r.Workload.Kind))
			}
		}
	case StylePod:
		var re string
		switch {
		case r.Kind == "":
			re = regexp.QuoteMeta(r.Namespace) + "/.+"
		case r.Kind == "Pod":
			re = regexp.QuoteMeta(r.Namespace + "/" + r.Name)
		default:
			// the workload's own name too: a workloads context ("<namespace>/<workload>") matches as well
			names := []string{regexp.QuoteMeta(r.Name)}
			if r.Workload != nil && r.Workload.Name != r.Name {
				names = append(names, regexp.QuoteMeta(r.Workload.Name))
			}
			for _, p := range r.Pods {
				names = append(names, regexp.QuoteMeta(p))
			}
			if r.PodsTruncated {
				notes = append(notes, NotePodsTruncated)
			}
			re = regexp.QuoteMeta(r.Namespace) + "/(" + strings.Join(names, "|") + ")"
		}
		in, out = []string{regexMatcher("destination", re)}, []string{regexMatcher("source", re)}
	default:
		return nil, nil
	}
	window := fmt.Sprintf("%ds", int(r.Range.Seconds()))
	q := func(side string, sel, peer []string) Query {
		by := append([]string{"reason"}, peer...)
		return Query{Side: side, Expr: fmt.Sprintf("sum by (%s) (increase(%s{%s}[%s]))", strings.Join(by, ", "), Metric, strings.Join(sel, ", "), window)}
	}
	return []Query{q("incoming", in, inPeer), q("outgoing", out, outPeer)}, notes
}

func peerLabels(shape Shape, end string) []string {
	if shape.Style == StylePod {
		return []string{end}
	}
	l := []string{end + "_namespace", end + "_workload"}
	if shape.Kind {
		l = append(l, end+"_workload_kind")
	}
	if shape.Pod {
		l = append(l, end+"_pod")
	}
	return l
}

// quote writes a PromQL string literal.
func quote(v string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(v) + `"`
}

func matcher(label, value string) string { return label + "=" + quote(value) }

func regexMatcher(label, re string) string { return label + "=~" + quote(re) }

// Sample is one series of a query's answer.
type Sample struct {
	Labels map[string]string
	Value  float64
}

// Peer is the other end of drops.
type Peer struct {
	Namespace string `json:"namespace,omitempty"`
	Workload  string `json:"workload,omitempty"`
	Kind      string `json:"kind,omitempty"`
	Pod       string `json:"pod,omitempty"`
	Reason    string `json:"reason"`
	Count     int64  `json:"count"`
}

// unknown: the metric did not name this end (outside the cluster, the host, or a label the agent leaves empty).
func (p Peer) unknown() bool { return p.Namespace == "" && p.Workload == "" && p.Pod == "" }

// Reason is a drop reason and how many.
type Reason struct {
	Reason string `json:"reason"`
	Count  int64  `json:"count"`
}

// Side is the drops on one side of the target, most first.
type Side struct {
	Total   int64    `json:"total"`
	Reasons []Reason `json:"reasons"`
	Peers   []Peer   `json:"peers"`
}

// MaxPeers caps the peers of a side.
const MaxPeers = 20

// Result is the answer.
type Result struct {
	Available bool      `json:"available"`
	Reason    string    `json:"reason,omitempty"` // why not available
	Source    string    `json:"source,omitempty"`
	Style     string    `json:"style,omitempty"`
	Namespace string    `json:"namespace"`
	Kind      string    `json:"kind,omitempty"`
	Name      string    `json:"name,omitempty"`
	Workload  *Workload `json:"workload,omitempty"`
	Range     string    `json:"range"`
	Incoming  Side      `json:"incoming"`
	Outgoing  Side      `json:"outgoing"`
	Notes     []string  `json:"notes,omitempty"`
	Redacted  bool      `json:"redacted,omitempty"`
}

// Assemble reads the answers of the queries (by side) into a Result.
func Assemble(shape Shape, r Request, notes []string, answers map[string][]Sample) Result {
	res := Result{Available: true, Source: "hubble", Style: shape.Style, Namespace: r.Namespace, Kind: r.Kind, Name: r.Name,
		Workload: r.Workload, Range: r.Range.String(), Notes: notes,
		Incoming: Side{Reasons: []Reason{}, Peers: []Peer{}}, Outgoing: Side{Reasons: []Reason{}, Peers: []Peer{}}}
	for _, side := range []string{"incoming", "outgoing"} {
		end := "source"
		if side == "outgoing" {
			end = "destination"
		}
		s, redacted := sideOf(shape, end, r.Scope, answers[side])
		res.Redacted = res.Redacted || redacted
		if side == "incoming" {
			res.Incoming = s
		} else {
			res.Outgoing = s
		}
	}
	return res
}

// sideOf sums one side's samples by reason and by peer; end is the label prefix of the peer.
func sideOf(shape Shape, end string, scope []string, samples []Sample) (Side, bool) {
	out := Side{Reasons: []Reason{}, Peers: []Peer{}}
	reasons := map[string]int64{}
	peers := map[Peer]int64{}
	redacted := false
	for _, s := range samples {
		n := int64(math.Round(s.Value))
		if n <= 0 {
			continue
		}
		reason := s.Labels["reason"]
		out.Total += n
		reasons[reason] += n
		p := peerOf(shape, end, s.Labels)
		if hide(&p, scope) {
			redacted = true
		}
		p.Reason = reason
		peers[p] += n
	}
	for k, v := range reasons {
		out.Reasons = append(out.Reasons, Reason{Reason: k, Count: v})
	}
	sort.Slice(out.Reasons, func(i, j int) bool {
		if out.Reasons[i].Count != out.Reasons[j].Count {
			return out.Reasons[i].Count > out.Reasons[j].Count
		}
		return out.Reasons[i].Reason < out.Reasons[j].Reason
	})
	for p, v := range peers {
		p.Count = v
		out.Peers = append(out.Peers, p)
	}
	sort.Slice(out.Peers, func(i, j int) bool {
		a, b := out.Peers[i], out.Peers[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if ua, ub := a.unknown(), b.unknown(); ua != ub { // a named peer before an unknown one
			return ub
		}
		return a.Namespace+"/"+a.Workload+"/"+a.Pod+"/"+a.Reason < b.Namespace+"/"+b.Workload+"/"+b.Pod+"/"+b.Reason
	})
	if len(out.Peers) > MaxPeers {
		out.Peers = out.Peers[:MaxPeers]
	}
	return out, redacted
}

func peerOf(shape Shape, end string, l map[string]string) Peer {
	if shape.Style == StylePod {
		v := l[end]
		if i := strings.Index(v, "/"); i > 0 {
			return Peer{Namespace: v[:i], Pod: v[i+1:]}
		}
		return Peer{Pod: v}
	}
	return Peer{Namespace: l[end+"_namespace"], Workload: l[end+"_workload"], Kind: l[end+"_workload_kind"], Pod: l[end+"_pod"]}
}

// hide keeps only the namespace of a peer outside the reader's namespaces; true when it did.
func hide(p *Peer, scope []string) bool {
	if scope == nil || p.Namespace == "" {
		return false
	}
	for _, ns := range scope {
		if ns == p.Namespace {
			return false
		}
	}
	changed := p.Workload != "" || p.Kind != "" || p.Pod != ""
	p.Workload, p.Kind, p.Pod = "", "", ""
	return changed
}
