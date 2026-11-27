// Package anomaly ranks what differs in a namespace between a window and the window of the same length right before it:
// failing objects, container terminations by reason, restarts, CPU throttling and memory against the limit, error log
// shapes and counts, requests, errors and latency of the services' server spans, the conditions of the nodes (not their
// CPU). It parses the window, builds the PromQL and turns the reads into findings; the caller runs the reads as the
// user. A check that could not run says why, so a missing source does not read as "normal", and a finding is new only
// when the window before has data, so a window before that was never recorded does not read as "it was not there"; an
// answer whose window before has no data for most of what it compared says so first (NoBaseline).
package anomaly

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The checks, in the order a tie is broken. The node check's name says what it reads, since a check that found nothing
// is listed under normal by its name alone: the nodes' conditions, not how busy their CPU is.
const (
	CheckIssues          = "issues"
	CheckCrashReasons    = "crash_reasons"
	CheckRestarts        = "restarts"
	CheckMemoryNearLimit = "memory_near_limit"
	CheckCPUThrottling   = "cpu_throttling"
	CheckErrorLogShapes  = "error_log_patterns"
	CheckErrorLogCounts  = "error_log_counts"
	CheckTraceErrors     = "trace_errors"
	CheckTraceLatency    = "trace_latency"
	CheckTraceRequests   = "trace_requests"
	CheckNodeConditions  = "node_conditions_not_cpu"
)

// Checks lists every check in tie order.
var Checks = []string{CheckIssues, CheckCrashReasons, CheckRestarts, CheckMemoryNearLimit, CheckCPUThrottling,
	CheckErrorLogShapes, CheckErrorLogCounts, CheckTraceErrors, CheckTraceLatency, CheckTraceRequests, CheckNodeConditions}

// LogChecks are the checks that read the log store, TraceChecks those that read the trace store.
var (
	LogChecks   = []string{CheckErrorLogShapes, CheckErrorLogCounts}
	TraceChecks = []string{CheckTraceErrors, CheckTraceLatency, CheckTraceRequests}
)

const (
	VerdictAnomalous = "anomalous"
	VerdictNormal    = "normal"
	VerdictNotRun    = "not_run"
)

// Limits of one answer.
const (
	MaxFindings = 10
	MaxExamples = 3
	// summaryMax keeps one finding's line short: the answer is read by a model with a result limit.
	summaryMax = 160
)

// The window's bounds: an hour by default, at least five minutes (a shorter one compares noise), at most a day, and the
// window before it within the week the stores are read back.
const (
	DefaultLength = time.Hour
	MinLength     = 5 * time.Minute
	MaxLength     = 24 * time.Hour
	MaxBack       = 7 * 24 * time.Hour
)

// Thresholds, simple and said out loud: a count that at least doubles or appears, a throttled share of a quarter of the
// CPU periods, memory at nine tenths of the limit, and growth by half for a share already past its threshold before.
const (
	CountRatio    = 2.0
	ThrottleShare = 0.25
	MemoryShare   = 0.9
	GrowthRatio   = 1.5
)

var ErrInvalidRequest = errors.New("invalid anomaly request")

func invalid(format string, a ...interface{}) error {
	return fmt.Errorf("%w: %s", ErrInvalidRequest, fmt.Sprintf(format, a...))
}

// Window is [Start, End).
type Window struct {
	Start time.Time
	End   time.Time
}

// Length is End - Start.
func (w Window) Length() time.Duration { return w.End.Sub(w.Start) }

// Before is the window of the same length that ends where w starts.
func (w Window) Before() Window { return Window{Start: w.Start.Add(-w.Length()), End: w.Start} }

// AlertWait is how long an alert's rule may wait before it fires, 15 minutes in most of the common rules and an hour in the
// longest: what the alert is about has been failing that long at its start, around which an investigation's window is.
const AlertWait = time.Hour

// WasThereBefore reports whether a state that began at since was there before w: all through the window before it, and
// AlertWait or longer when w starts. One that began in between is what changed, or may be what an alert waited for.
func (w Window) WasThereBefore(since time.Time) bool {
	return since.Before(w.Before().Start) && since.Before(w.Start.Add(-AlertWait))
}

// ParseWindow reads start and end (RFC3339, both optional). The end defaults to now, cut to the minute so that the same
// question in the same minute is the same window; an end after now is now. The start defaults to an hour before the end.
func ParseWindow(start, end string, now time.Time) (Window, error) {
	w := Window{End: now.Truncate(time.Minute)}
	if end != "" {
		t, err := time.Parse(time.RFC3339, end)
		if err != nil {
			return w, invalid("end must be an RFC3339 time")
		}
		if t.Before(now) {
			w.End = t
		}
	}
	w.Start = w.End.Add(-DefaultLength)
	if start != "" {
		t, err := time.Parse(time.RFC3339, start)
		if err != nil {
			return w, invalid("start must be an RFC3339 time")
		}
		w.Start = t
	}
	switch length := w.Length(); {
	case length <= 0:
		return w, invalid("start must be before end and before now")
	case length < MinLength:
		return w, invalid("the window is at least %s", MinLength)
	case length > MaxLength:
		return w, invalid("the window is at most %s", MaxLength)
	}
	if now.Sub(w.Before().Start) > MaxBack {
		return w, invalid("the window and the one before it reach at most %s back", MaxBack)
	}
	return w, nil
}

// WorkloadKinds are the owners a pod can be narrowed to.
var WorkloadKinds = map[string]bool{"Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true}

var (
	objectNameRe    = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
	namespaceNameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
)

// ParseNamespace checks the namespace is a namespace name (DNS-1123 label) before it goes into a query.
func ParseNamespace(namespace string) error {
	if len(namespace) > 63 || !namespaceNameRe.MatchString(namespace) {
		return invalid("namespace is not a namespace name")
	}
	return nil
}

// Workload narrows the checks to one owner's pods.
type Workload struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// ParseWorkload reads the optional workload: both or neither.
func ParseWorkload(kind, name string) (*Workload, error) {
	if kind == "" && name == "" {
		return nil, nil
	}
	if kind == "" || name == "" {
		return nil, invalid("workload_kind and workload_name go together")
	}
	if !WorkloadKinds[kind] {
		return nil, invalid("workload_kind is one of Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob")
	}
	if len(name) > 253 || !objectNameRe.MatchString(name) {
		return nil, invalid("workload_name is not an object name")
	}
	return &Workload{Kind: kind, Name: name}, nil
}

// OwnsPod reports whether a pod with these owner references (podrow's "owner_references") belongs to w: its own owner,
// or the ReplicaSet of a Deployment (<name>-<pod-template-hash>) and the Job of a CronJob (<name>-<schedule minute>, or
// <name>-manual-<unix second> as Kubeast's trigger names it), so cart-api's ReplicaSet is not cart's.
func (w *Workload) OwnsPod(owners []map[string]interface{}) bool {
	if w == nil {
		return true
	}
	for _, o := range owners {
		kind, _ := o["kind"].(string)
		name, _ := o["name"].(string)
		switch {
		case kind == w.Kind && name == w.Name:
			return true
		case w.Kind == "Deployment" && kind == "ReplicaSet" && suffixed(name, w.Name+"-", hashLetters):
			return true
		case w.Kind == "CronJob" && kind == "Job" && (suffixed(name, w.Name+"-", digitLetters) || suffixed(name, w.Name+"-manual-", digitLetters)):
			return true
		}
	}
	return false
}

// hashLetters are the letters of a pod-template-hash and of the 5 the API server adds to a generated name
// (k8s.io/apimachinery util/rand); digitLetters those of a Job's schedule minute and of an index.
const (
	hashLetters  = "bcdfghjklmnpqrstvwxz2456789"
	digitLetters = "0123456789"
)

// suffixed: name is prefix and then 1 to 10 of letters.
func suffixed(name, prefix, letters string) bool {
	rest, ok := strings.CutPrefix(name, prefix)
	return ok && rest != "" && len(rest) <= 10 && strings.Trim(rest, letters) == ""
}

// generatedBase is the longest generateName base the API server keeps before its 5 letters (apiserver names: 63 in all).
const generatedBase = 58

// namePart is a literal, or a run of min to max letters of class, in a generated name.
type namePart struct {
	lit      string
	class    string
	min, max int
}

// cutTo is the pattern of the names parts make, cut to their first room bytes as the API server cuts a long base.
func cutTo(parts []namePart, room int) string {
	if len(parts) == 0 || room <= 0 {
		return ""
	}
	p := parts[0]
	if p.class == "" {
		if len(p.lit) >= room {
			return regexp.QuoteMeta(p.lit[:room])
		}
		return regexp.QuoteMeta(p.lit) + cutTo(parts[1:], room-len(p.lit))
	}
	type alt struct {
		lo, hi int
		rest   string
	}
	var alts []alt
	for n := p.min; n <= p.max; n++ {
		kept := min(n, room)
		rest := cutTo(parts[1:], room-kept)
		if last := len(alts) - 1; last >= 0 && alts[last].rest == rest && kept-alts[last].hi <= 1 {
			alts[last].hi = kept
			continue
		}
		alts = append(alts, alt{kept, kept, rest})
	}
	out := make([]string, len(alts))
	for i, a := range alts {
		out[i] = p.class + repeat(a.lo, a.hi) + a.rest
	}
	return group(out)
}

func repeat(lo, hi int) string {
	if lo == hi {
		return fmt.Sprintf("{%d}", lo)
	}
	return fmt.Sprintf("{%d,%d}", lo, hi)
}

func group(alts []string) string {
	if len(alts) == 1 {
		return alts[0]
	}
	return "(?:" + strings.Join(alts, "|") + ")"
}

// indexedBase is the base of an indexed Job's pods, <job>-<index>-, the Job's name cut so it stays within
// generatedBase (the job controller's podGenerateNameWithIndex), for an index of 1 to 6 digits.
func indexedBase(job []namePart) string {
	var alts []string
	from := 1
	for d := 1; d <= 6; d++ {
		name := cutTo(job, generatedBase-d-2)
		if d < 6 && cutTo(job, generatedBase-d-3) == name {
			continue
		}
		alts = append(alts, name+"-[0-9]"+repeat(from, d)+"-")
		from = d + 1
	}
	return group(alts)
}

// PodPattern is the regular expression of the names w's controller gives its pods: a Deployment's
// <name>-<pod-template-hash>-<5 letters>, a ReplicaSet's and a DaemonSet's <name>-<5 letters>, a Job's that or
// <name>-<index>-<5 letters>, a CronJob's the same after its Job's name, a StatefulSet's <name>-<ordinal>; a base past
// generatedBase is cut as the API server cuts it. So a sibling whose name starts with w's (cart, cart-api) is left out.
// Log search's workload filter (logsearch.Config.LogQL) matches the pod label by it too.
func (w *Workload) PodPattern() string {
	random := "[" + hashLetters + "]{5}"
	digits := namePart{class: "[0-9]", min: 1, max: 10}
	var bases, jobs [][]namePart
	switch w.Kind {
	case "StatefulSet":
		return regexp.QuoteMeta(w.Name) + "-[0-9]+"
	case "Deployment":
		bases = [][]namePart{{{lit: w.Name + "-"}, {class: "[" + hashLetters + "]", min: 1, max: 10}, {lit: "-"}}}
	case "CronJob":
		jobs = [][]namePart{{{lit: w.Name + "-"}, digits}, {{lit: w.Name + "-manual-"}, digits}}
	case "Job":
		jobs = [][]namePart{{{lit: w.Name}}}
	default:
		bases = [][]namePart{{{lit: w.Name + "-"}}}
	}
	var alts []string
	for _, b := range bases {
		alts = append(alts, cutTo(b, generatedBase)+random)
	}
	for _, job := range jobs {
		alts = append(alts, cutTo(append(append([]namePart{}, job...), namePart{lit: "-"}), generatedBase)+random, indexedBase(job)+random)
	}
	return group(alts)
}

// podMatcher is the PromQL label matcher of w's pods by name — pods that are gone have no owner left to read.
func (w *Workload) podMatcher() string {
	if w == nil {
		return ""
	}
	return `,pod=~` + strconv.Quote(w.PodPattern())
}

// NoEarlier is said in a finding's summary in place of the window before's value when that window has no data for it:
// whether it is new is then not known.
const NoEarlier = "no earlier data"

// ThereBefore is said in NoEarlier's place of a state that was there before the window (Finding.AlreadyThere).
const ThereBefore = "already there before the window"

// Finding is one thing a check found, or one target it compared. New: the window before has data and none of it there;
// with no data in the window before it is not set, before is left out and the summary says NoEarlier. Since, where it was
// asked for, is from when the record shows a state, AlreadyThere that it was there before (Window.WasThereBefore), and Worse that another
// check found its object grown in the window all the same.
type Finding struct {
	Check    string   `json:"check"`
	Target   string   `json:"target"`
	Verdict  string   `json:"verdict"`
	Summary  string   `json:"summary"`
	Before   *float64 `json:"before,omitempty"`
	Now      *float64 `json:"now,omitempty"`
	Ratio    *float64 `json:"ratio,omitempty"`
	New      bool     `json:"new,omitempty"`
	Examples []string `json:"examples,omitempty"`

	Since        string `json:"since,omitempty"`
	AlreadyThere bool   `json:"already_there,omitempty"`
	Worse        bool   `json:"worse,omitempty"`

	// For Rank, not in the answer: critical is a critical state now, which no window before is compared with; noEarlier a
	// value past its threshold with nothing known of the window before; pods are those the terminations are of.
	critical  bool
	noEarlier bool
	pods      []string
}

// CheckResult is what one check gives: findings, or the reason it did not run. Partial says what part of its reads it
// could not make when it ran on the rest.
type CheckResult struct {
	Check    string
	Findings []Finding
	NotRun   string
	Partial  string
}

// NotRun names a check that did not run and why.
type NotRun struct {
	Check  string `json:"check"`
	Reason string `json:"reason"`
}

// Partial names a check that ran on part of what it reads and what it could not read: its findings, or its place under
// normal, are about the part it read.
type Partial struct {
	Check  string `json:"check"`
	Reason string `json:"reason"`
}

// WindowJSON is a window as RFC3339 times.
type WindowJSON struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

func windowJSON(w Window) WindowJSON {
	return WindowJSON{Start: w.Start.UTC().Format(time.RFC3339), End: w.End.UTC().Format(time.RFC3339)}
}

// Result is the answer: the ranked findings, the checks that found nothing, the checks that did not run and those that
// ran on part of what they read.
type Result struct {
	Namespace     string     `json:"namespace"`
	Workload      *Workload  `json:"workload,omitempty"`
	Window        WindowJSON `json:"window"`
	ComparedWith  WindowJSON `json:"compared_with"`
	Findings      []Finding  `json:"findings"`
	FindingsTotal int        `json:"findings_total"`
	Normal        []string   `json:"normal"`
	NotRun        []NotRun   `json:"not_run"`
	Partial       []Partial  `json:"partial,omitempty"`
	StoreQueries  int        `json:"store_queries"`
	// CallOrder: how the call graph ordered the findings of the namespace's failing workloads, present only when it was
	// asked (features.callGraph on and findings on two workloads or more).
	CallOrder *CallOrderNote `json:"call_order,omitempty"`
	// NoBaseline: present only when the window before has no data for most of the values the checks compared.
	NoBaseline *NoBaseline `json:"no_baseline,omitempty"`
}

// NoBaseline says that the window before has no data for most of the values the checks compared, the normal ones too: a
// namespace or pods newer than that window, or each pod replaced in the window. The findings are then what is there now
// rather than what changed, those with no earlier data in the order of their size, after any that grew against the
// window before (rankWithoutBaseline).
type NoBaseline struct {
	Compared      int    `json:"compared"`
	NoEarlierData int    `json:"no_earlier_data"`
	Note          string `json:"note"`
}

// NoBaselineNote is NoBaseline's note.
const NoBaselineNote = "Most values compared have no data in the window before, so the findings show what is there now, not what changed. " +
	"Read the namespace's events, recent changes and logs before following the first finding."

// earlierData counts the values the checks compared with the window before (the findings with a value, normal ones too:
// issues and node conditions compare nothing) and those of them with no data there.
type earlierData struct{ compared, none int }

func (e *earlierData) add(f Finding) {
	if f.Now == nil {
		return
	}
	e.compared++
	if f.noEarlier {
		e.none++
	}
}

// note is NoBaseline when the window before has no data for more than half of the values compared, else nil.
func (e earlierData) note() *NoBaseline {
	if 2*e.none <= e.compared {
		return nil
	}
	return &NoBaseline{Compared: e.compared, NoEarlierData: e.none, Note: NoBaselineNote}
}

// MaxCallOrderSuspects bounds the suspects call_order names.
const MaxCallOrderSuspects = 5

// CallOrder is the call graph's order of the namespace's failing workloads (callgraph.Suspects: a failing workload
// whose callees are all well first, its failing callers after it) and the workload each finding's target belongs to.
// Assemble puts the findings of those workloads in that order within the places they hold among the ranked findings;
// the other findings keep their places. A cause then comes before its victims whatever their counts.
type CallOrder struct {
	// Suspects are workload IDs in the call graph's order; empty when the call graph gave none (Note says why).
	Suspects []string
	// Workload is a finding target's workload ID, "" when it names none.
	Workload func(target string) string
	Note     CallOrderNote
}

// CallOrderNote is call_order in the answer.
type CallOrderNote struct {
	Applied bool   `json:"applied"`
	Reason  string `json:"reason,omitempty"`
	// Suspects: the call graph's first failing workloads, those whose callees are all well first.
	Suspects []string `json:"suspects,omitempty"`
	// Moved: the findings that changed place.
	Moved int `json:"moved"`
	// Truncated: the calls answer it was made from was cut (its truncated or a source's): a call or its failures may be missing.
	Truncated bool `json:"truncated,omitempty"`
}

// apply reorders found (ranked) as CallOrder says and counts the findings that moved.
func (o *CallOrder) apply(found []Finding) int {
	pos := make(map[string]int, len(o.Suspects))
	for i, id := range o.Suspects {
		if _, ok := pos[id]; !ok {
			pos[id] = i
		}
	}
	type placed struct {
		at, rank int
		f        Finding
	}
	var held []placed
	for i, f := range found {
		if o.Workload == nil {
			break
		}
		if rank, ok := pos[o.Workload(f.Target)]; ok {
			held = append(held, placed{at: i, rank: rank, f: f})
		}
	}
	slots := make([]int, len(held))
	for k, p := range held {
		slots[k] = p.at
	}
	sort.SliceStable(held, func(a, b int) bool { return held[a].rank < held[b].rank })
	moved := 0
	for k, p := range held {
		if p.at != slots[k] {
			moved++
		}
		found[slots[k]] = p.f
	}
	return moved
}

// Assemble ranks the anomalous findings of every check and keeps the first MaxFindings; a check with none is normal.
func Assemble(namespace string, wl *Workload, w Window, results []CheckResult, storeQueries int) Result {
	return AssembleWith(namespace, wl, w, results, storeQueries, nil)
}

// AssembleWith is Assemble with the call graph's order of the failing workloads put on the ranked findings before
// they are cut (order nil: Assemble).
func AssembleWith(namespace string, wl *Workload, w Window, results []CheckResult, storeQueries int, order *CallOrder) Result {
	out := Result{Namespace: namespace, Workload: wl, Window: windowJSON(w), ComparedWith: windowJSON(w.Before()),
		Findings: []Finding{}, Normal: []string{}, NotRun: []NotRun{}, StoreQueries: storeQueries}
	byCheck := map[string]CheckResult{}
	for _, r := range results {
		byCheck[r.Check] = r
	}
	var found []Finding
	var earlier earlierData
	for _, check := range Checks {
		r, ok := byCheck[check]
		if !ok {
			continue
		}
		if r.NotRun != "" {
			out.NotRun = append(out.NotRun, NotRun{Check: check, Reason: r.NotRun})
			continue
		}
		anomalous := 0
		for _, f := range r.Findings {
			if f.Verdict == VerdictAnomalous {
				found = append(found, f)
				anomalous++
			} else {
				earlier.add(f)
			}
		}
		if anomalous == 0 {
			out.Normal = append(out.Normal, check)
		}
		if r.Partial != "" {
			out.Partial = append(out.Partial, Partial{Check: check, Reason: r.Partial})
		}
	}
	markBefore(found)
	for _, f := range found {
		earlier.add(f)
	}
	if out.NoBaseline = earlier.note(); out.NoBaseline != nil {
		rankWithoutBaseline(found)
	} else {
		Rank(found)
	}
	if order != nil {
		note := order.Note
		if len(order.Suspects) > 0 {
			note.Applied, note.Moved = true, order.apply(found)
			note.Suspects = append([]string{}, order.Suspects[:min(len(order.Suspects), MaxCallOrderSuspects)]...)
		}
		out.CallOrder = &note
	}
	out.FindingsTotal = len(found)
	if len(found) > MaxFindings {
		found = found[:MaxFindings]
	}
	out.Findings = append(out.Findings, found...)
	return out
}

func checkOrder(check string) int {
	for i, c := range Checks {
		if c == check {
			return i
		}
	}
	return len(Checks)
}

func value(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// markBefore settles what the states that began before the window (AlreadyThere) say of the other findings: the
// terminations of such pods alone were there before too, and a pod another check found new or grown is Worse. With no
// such state (none is asked for without with_since) it changes nothing.
func markBefore(found []Finding) {
	before, grew := map[string]bool{}, map[string]bool{}
	for _, f := range found {
		pod, isPod := targetPod(f.Target)
		switch {
		case f.Check == CheckIssues:
			if isPod && f.AlreadyThere {
				before[pod] = true
			}
		case f.New || value(f.Ratio) > 1:
			for _, p := range f.pods {
				grew[p] = true
			}
			if isPod {
				grew[pod] = true
			}
		}
	}
	if len(before) == 0 {
		return
	}
	for i := range found {
		f := &found[i]
		switch f.Check {
		case CheckIssues:
			if pod, ok := targetPod(f.Target); ok {
				f.Worse = before[pod] && grew[pod]
			}
		case CheckCrashReasons:
			if f.noEarlier && !slices.ContainsFunc(f.pods, func(p string) bool { return !before[p] }) {
				f.AlreadyThere, f.noEarlier = true, false
				f.Summary = strings.Replace(f.Summary, NoEarlier, ThereBefore, 1)
			}
		}
	}
}

// targetPod is the pod a finding's target names: "Pod/<name>", alone or with a container after it.
func targetPod(target string) (string, bool) {
	name, ok := strings.CutPrefix(target, "Pod/")
	name, _, _ = strings.Cut(name, " ")
	return name, ok
}

// tier is where Rank starts: what is new or critical now, then what has no earlier data, then the rest (what grew, and
// the warnings, which have no value to rank by, last). A state that was there before the window is one of the rest, unless
// it got worse in it.
func (f Finding) tier() int {
	switch {
	case f.New || (f.critical && (!f.AlreadyThere || f.Worse)):
		return 0
	case f.noEarlier:
		return 1
	}
	return 2
}

// tierWithoutBaseline is tier in an answer whose window before has no data for most values (NoBaseline): what grew against
// the window before comes right after what is new or critical now, before what has no earlier data, which is then most of
// the answer and only says what is there now.
func (f Finding) tierWithoutBaseline() int {
	switch t := f.tier(); {
	case t == 0:
		return 0
	case t == 2 && f.Ratio != nil:
		return 1
	case t == 1:
		return 2
	}
	return 3
}

// Rank orders findings: what is new or critical now first, then what has no earlier data, then the larger ratio, then
// the larger value, then the check order and the target, so the same reads give the same order.
func Rank(findings []Finding) { rank(findings, Finding.tier) }

// rankWithoutBaseline is Rank by tierWithoutBaseline.
func rankWithoutBaseline(findings []Finding) { rank(findings, Finding.tierWithoutBaseline) }

func rank(findings []Finding, tier func(Finding) int) {
	sort.SliceStable(findings, func(i, j int) bool {
		a, b := findings[i], findings[j]
		if ta, tb := tier(a), tier(b); ta != tb {
			return ta < tb
		}
		if ra, rb := value(a.Ratio), value(b.Ratio); ra != rb {
			return ra > rb
		}
		if na, nb := value(a.Now), value(b.Now); na != nb {
			return na > nb
		}
		if oa, ob := checkOrder(a.Check), checkOrder(b.Check); oa != ob {
			return oa < ob
		}
		return a.Target < b.Target
	})
}

func num(v float64) *float64 {
	v = math.Round(v*1000) / 1000
	return &v
}

func shorten(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= summaryMax {
		return s
	}
	cut := summaryMax
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}

// compare fills a finding's before, now, ratio and new from two values; before is nil when the window before has no
// data, and the finding is then not new.
func compare(f *Finding, before *float64, now float64) {
	f.Now = num(now)
	switch {
	case before == nil:
		f.noEarlier = true
	case *before == 0:
		f.Before = num(0)
		f.New = now > 0
	default:
		f.Before = num(*before)
		f.Ratio = num(now / *before)
	}
}

// earlierText is the window before's value in format, or NoEarlier when it has no data.
func earlierText(before *float64, format string) string {
	if before == nil {
		return NoEarlier
	}
	return fmt.Sprintf(format, *before)
}

// countAnomalous: a count that appeared, or at least doubled.
func countAnomalous(before *float64, now float64) bool {
	if now <= 0 {
		return false
	}
	return before == nil || *before == 0 || now/(*before) >= CountRatio
}

// shareAnomalous: a share past its threshold that was under it before, was not there, or grew by half.
func shareAnomalous(before *float64, now, threshold float64) bool {
	if now < threshold {
		return false
	}
	return before == nil || *before < threshold || now/(*before) >= GrowthRatio
}
