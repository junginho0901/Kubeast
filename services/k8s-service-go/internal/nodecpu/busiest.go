package nodecpu

import (
	"cmp"
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Limits of the busiest CPU line (features.nodeNeighbors.busiestCPU): the line of get_node_metrics without a node. Nodes
// with more CPUs than BusiestMaxCPUs together are not read: five modes a CPU of node-exporter are 10 000 series an hour.
// The query reads the nodes' CPUs alone (BusiestQuery), whatever other hosts Prometheus holds.
const (
	BusiestQueries    = 4
	BusiestMaxCPUs    = 2000
	BusiestCandidates = 20
	BusiestPods       = 5
	// busiestLately is how many of the last steps are now: a CPU that was full in one of them comes before one that was
	// full earlier in the hour.
	busiestLately = 5
	// busiestNearPeak: of a CPU that was never full, a step this close to its highest is as busy.
	busiestNearPeak = 0.02
	// busiestLeastCores: a pod under this is noise in the line.
	busiestLeastCores = 0.01
)

// NoCPUsOfNodes: the store's CPUs are none of the nodes'.
const NoCPUsOfNodes = "no node_cpu_seconds_total (node-exporter) or system_cpu_time_seconds_total (hostmetrics) series of the last hour whose node label or instance is one of the nodes"

// FineSteps cuts a window in steps of at most a thirtieth of it (MinStep still holds), so a CPU that was full for a few
// minutes of two hours is not averaged into one that was not.
const FineSteps = 30

// ParseFineWindow is ParseWindow with FineSteps steps.
func ParseFineWindow(start, end string, now time.Time) (Window, error) {
	return parseWindow(start, end, now, FineSteps)
}

// BusiestWindow is the last hour up to now's minute, as the two windows the package reads: the half hour and the half
// hour before it, FineSteps steps of MinStep in all.
func BusiestWindow(now time.Time) Window {
	end, half := now.Truncate(time.Minute), MinStep*FineSteps/2
	return Window{Start: end.Add(-half), End: end, Step: MinStep, Steps: FineSteps / 2}
}

// BusiestQuery is the busy share of the BusiestCandidates busiest CPUs of nodes in each step, from node-exporter or the
// OpenTelemetry hostmetrics receiver. It asks for the nodes' series alone (the rule of nodeOf), so that another host in the
// same Prometheus takes no place among them and BusiestMaxCPUs bounds what is read. fits is false when the names of the
// nodes do not fit one query (MaxQueryBytes).
func BusiestQuery(w Window, nodes []Node) (query string, fits bool) {
	if len(nodes) == 0 {
		return "", false
	}
	var names, addresses []string
	for _, n := range nodes {
		names = append(names, n.Name)
		for _, a := range n.Addresses {
			if ip := net.ParseIP(a); ip != nil && ip.To4() == nil {
				a = "[" + a + "]"
			}
			addresses = withMember(addresses, a)
		}
	}
	slices.Sort(names)
	slices.Sort(addresses)
	named, hosts := oneOf(names), oneOf(names)
	if len(addresses) > 0 {
		hosts += "|" + oneOf(addresses)
	}
	exporter := either("rate", "node_cpu_seconds_total", `mode!~"idle|iowait|steal"`, []string{
		"node=~" + strconv.Quote(named), `node="",instance=~` + strconv.Quote("(?:"+hosts+")(?::[0-9]+)?")}, w)
	receiver := either("rate", "system_cpu_time_seconds_total", `state!~"idle|wait|steal"`, []string{"k8s_node_name=~" + strconv.Quote(named)}, w)
	query = fmt.Sprintf(`topk(%d, sum by (node, instance, cpu) (max by (node, instance, cpu, mode) (%s))`+
		` or sum by (k8s_node_name, cpu) (max by (k8s_node_name, cpu, state) (%s)))`, BusiestCandidates, exporter, receiver)
	return query, len(url.QueryEscape(query)) <= MaxQueryBytes
}

// oneOf matches one of names, what they all start and end with written once. A dot matches any character: nodeOf keeps a
// series to its node's name.
func oneOf(names []string) string {
	start := names[0]
	for _, n := range names {
		for !strings.HasPrefix(n, start) {
			start = start[:len(start)-1]
		}
	}
	end := names[0][len(start):]
	for _, n := range names {
		for !strings.HasSuffix(n[len(start):], end) {
			end = end[1:]
		}
	}
	middle := make([]string, len(names))
	for i, n := range names {
		middle[i] = literal(n[len(start) : len(n)-len(end)])
	}
	return literal(start) + "(?:" + strings.Join(middle, "|") + ")" + literal(end)
}

func literal(s string) string { return strings.ReplaceAll(regexp.QuoteMeta(s), `\.`, ".") }

// busyness is how busy a CPU was: one that was full lately first, then the one that was full the most steps, then the one
// with the highest step and the highest mean.
type busyness struct {
	lately     bool
	full       int
	peak, mean float64
}

func (b busyness) compare(o busyness) int {
	if b.lately != o.lately {
		if b.lately {
			return 1
		}
		return -1
	}
	return cmp.Or(cmp.Compare(b.full, o.full), cmp.Compare(b.peak, o.peak), cmp.Compare(b.mean, o.mean))
}

// busynessOf is g's, and whether g has a value.
func busynessOf(g Grid) (busyness, bool) {
	var b busyness
	var steps []int
	for i, v := range g {
		steps = append(steps, i)
		if v >= CPUBusyShare {
			b.full++
			b.lately = b.lately || i >= len(g)-busiestLately
		}
	}
	b.peak, _, _ = g.peak(steps)
	var ok bool
	b.mean, ok = g.mean(steps, false)
	return b, ok
}

// Node is a node the caller may list.
type Node struct {
	Name      string
	Addresses []string
	CPUs      float64
}

// NodesFromRows reads the nodes from their list rows, and how many CPUs they have together.
func NodesFromRows(rows []map[string]interface{}) (nodes []Node, cpus float64) {
	for _, row := range rows {
		n := Node{Name: str(row, "name")}
		if n.Name == "" {
			continue
		}
		for _, key := range []string{"internal_ip", "external_ip"} {
			if a := str(row, key); a != "" {
				n.Addresses = append(n.Addresses, a)
			}
		}
		n.CPUs, _ = Cores(quantity(row, "capacity"))
		cpus += n.CPUs
		nodes = append(nodes, n)
	}
	return nodes, cpus
}

// BusiestNode is the node of the busiest of BusiestQuery's series that is one of nodes: the query's names match a little
// more than the nodes'. ok is false when none is.
func BusiestNode(w Window, series []Series, nodes []Node) (node Node, ok bool) {
	var best busyness
	for _, s := range series {
		at, found := nodeOf(s.Labels, nodes)
		if !found {
			continue
		}
		b, any := busynessOf(w.Grid(s.Points))
		if !any {
			continue
		}
		if c := b.compare(best); ok && (c < 0 || (c == 0 && at.Name >= node.Name)) {
			continue
		}
		node, best, ok = at, b, true
	}
	return node, ok
}

// nodeOf is the node a CPU's series is of, by Selectors' rule: the label node (hostmetrics' k8s_node_name), and for a
// scrape that sets none its instance, the node's name or one of its addresses with or without a port.
func nodeOf(labels map[string]string, nodes []Node) (Node, bool) {
	name := labels["node"]
	if name == "" {
		name = labels["k8s_node_name"]
	}
	host := ""
	if name == "" {
		host = labels["instance"]
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
	}
	for _, n := range nodes {
		if (name != "" && n.Name == name) || (host != "" && (n.Name == host || slices.Contains(n.Addresses, host))) {
			return n, true
		}
	}
	return Node{}, false
}

// BusiestInput is what the caller read for the line: Input of the busiest CPU's node, with the window's CPUs, container
// cores, pods and which namespaces may be named. Why says why no node was found, UsageWhy why its containers were not read.
type BusiestInput struct {
	Input
	Nodes    int
	Why      string
	UsageWhy string
}

// BusiestResult is the answer.
type BusiestResult struct {
	Line         string     `json:"line"`
	Window       WindowJSON `json:"window"`
	StepSeconds  int        `json:"step_seconds"`
	StoreQueries int        `json:"store_queries"`
}

// Busiest is the line: the busiest CPU of the nodes in w's hour and the pods that used the most CPU on its node in that
// step, over every namespace, those in a namespace the caller may not list counted and not named (as containers()).
func Busiest(in BusiestInput) BusiestResult {
	w := in.Window
	return BusiestResult{
		Line:   busiestLine(in),
		Window: WindowJSON{rfc3339(w.BeforeStart()), rfc3339(w.End)}, StepSeconds: int(w.Step / time.Second), StoreQueries: in.Queries,
	}
}

func busiestLine(in BusiestInput) string {
	const average = "a node's percentage is the average over its CPUs, in which one full CPU does not show"
	w := in.Window
	cpus := readCPUs(w, in.CPUs)
	cpu, busy := cpus.busiestNow()
	if in.Why == "" && len(busy) == 0 {
		in.Why = NoCPUsOfNodes
	}
	if in.Why != "" {
		return "The nodes' CPUs one by one were not read (" + in.Why + "): " + average + "."
	}
	if in.ByPods {
		in.Usage = ofPods(in.Usage, in.Pods)
	}
	at := lastWith(in.Usage, busy)
	g := cpus.per[cpu]
	peak, _, _ := g.peak(allSteps(w))
	over, _ := g.mean(allSteps(w), false)
	head := fmt.Sprintf("Busiest CPU in the last hour over %s (%d steps of %s): CPU %s of Node/%s, %s busy at its highest, %s over the hour",
		counted(in.Nodes, "node"), len(g), shortStep(w.Step), cpu, in.Node, percent(peak), percent(over))
	if peak >= CPUBusyShare {
		first, last, n := -1, -1, 0
		for i, v := range g {
			if v >= CPUBusyShare {
				if first < 0 {
					first = i
				}
				last, n = i, n+1
			}
		}
		head += fmt.Sprintf(", 90%% or more in %s (from %s to %s)", counted(n, "step"), rfc3339(w.stepStart(first)), rfc3339(w.stepStart(last+1)))
		if avg := cpus.avg[at]; avg < NodeBusyShare {
			head += fmt.Sprintf("; the average over that node's %d CPUs was %s then, so one full CPU does not show in the node's percentage", cpus.count, percent(avg))
		}
	} else {
		head += ": no CPU that was read was full for a whole step (a shorter burst is averaged over it)"
	}
	return head + ". " + busiestPods(in, cpus, at) + " get_node_metrics with node=" + in.Node + " compares it with the time before."
}

// busiestPods says which pods used the most CPU in step at, over every namespace.
func busiestPods(in BusiestInput, cpus cpuGrid, at int) string {
	type pod struct {
		name, owner string
		cores       float64
		gone        bool
	}
	pods := map[[2]string]*pod{}
	hiddenPods, hiddenNamespaces := map[[2]string]bool{}, map[string]bool{}
	var hidden, total float64
	for _, c := range containers(in.Input, []int{at}, nil, allSteps(in.Window)) {
		if !c.ran {
			continue
		}
		total += c.cores
		key := [2]string{c.key.Namespace, c.key.Pod}
		if !c.named {
			hidden += c.cores
			hiddenPods[key], hiddenNamespaces[c.key.Namespace] = true, true
			continue
		}
		p := pods[key]
		if p == nil {
			p = &pod{name: c.key.Namespace + "/" + c.key.Pod, owner: c.owner, gone: c.gone}
			pods[key] = p
		}
		p.cores += c.cores
	}
	if len(pods) == 0 && len(hiddenPods) == 0 {
		why := in.UsageWhy
		if why == "" {
			why = NoUsage
		}
		if in.PodsError != "" {
			why += "; " + in.PodsError
		}
		return "Which pods used it was not read (" + why + ")."
	}
	ranked := make([]*pod, 0, len(pods))
	for _, p := range pods {
		if p.cores >= busiestLeastCores {
			ranked = append(ranked, p)
		}
	}
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].cores != ranked[j].cores {
			return ranked[i].cores > ranked[j].cores
		}
		return ranked[i].name < ranked[j].name
	})
	var parts []string
	for i, p := range ranked {
		if i == BusiestPods {
			break
		}
		text := p.name
		if p.owner != "" {
			text += " (" + p.owner + ")"
		}
		if p.gone {
			text += " [gone]"
		}
		parts = append(parts, text+" "+cores(p.cores))
	}
	if len(parts) == 0 {
		parts = append(parts, fmt.Sprintf("no pod that may be named %s cores or more", cores(busiestLeastCores)))
	}
	line := fmt.Sprintf("Most CPU on that node from %s to %s, over every namespace, in cores: %s", rfc3339(in.Window.stepStart(at)), rfc3339(in.Window.stepStart(at+1)), strings.Join(parts, ", "))
	if len(hiddenPods) > 0 {
		whose := "you may not read"
		if in.PodsError != "" {
			whose = "whose pods you may not list, or it was not asked whether you may,"
		}
		line += fmt.Sprintf("; %s in %s %s used %s together, counted and not named", counted(len(hiddenPods), "pod"), counted(len(hiddenNamespaces), "namespace"), whose, cores(hidden))
	}
	if in.PodsError != "" {
		line += "; " + in.PodsError
	}
	if other := cpus.avg[at]*float64(cpus.count) - total; !math.IsNaN(other) && other >= GrewCores {
		line += fmt.Sprintf("; %s outside the containers", cores(other))
	}
	if in.UsageWhy != "" {
		line += "; " + in.UsageWhy
	}
	return line + "."
}

// busiestNow is the busiest CPU (busyness, then by name) and the steps in which it was busy: those it was full, or of one
// that never was those near its highest. None when no CPU has a value.
func (c cpuGrid) busiestNow() (cpu string, at []int) {
	var best busyness
	for name, g := range c.per {
		b, any := busynessOf(g)
		if !any {
			continue
		}
		if d := b.compare(best); cpu != "" && (d < 0 || (d == 0 && name >= cpu)) {
			continue
		}
		cpu, best = name, b
	}
	busy := CPUBusyShare
	if best.full == 0 {
		busy = best.peak - busiestNearPeak
	}
	for i, v := range c.per[cpu] {
		if v >= busy {
			at = append(at, i)
		}
	}
	return cpu, at
}

// lastWith is the last of steps in which usage has a value, the last of them when it has none: a store's newest step can
// hold the node's samples and not yet the containers'.
func lastWith(usage map[Key]Grid, steps []int) int {
	for i := len(steps) - 1; i >= 0; i-- {
		for _, g := range usage {
			if !math.IsNaN(g[steps[i]]) {
				return steps[i]
			}
		}
	}
	return steps[len(steps)-1]
}

func counted(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	return fmt.Sprintf("%d %ss", n, what)
}

// shortStep writes 2m0s as 2m.
func shortStep(d time.Duration) string { return strings.TrimSuffix(d.String(), "0s") }
