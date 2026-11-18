package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/junginho0901/kubeast/services/pkg/response"
)

// The Timeline's changes view: what changed in a window, read from what the objects keep after their events are gone.
// Only when and what is read — names, images, revisions, counts — never a value: ConfigMaps and Secrets are listed as
// metadata only (PartialObjectMetadataList), and of an environment variable, a label or an annotation only the key is
// written. The informer cache is not used: it watches as kubeast:cache, keeps none of these kinds but nodes and drops
// the node conditions' times (stripNode), so every list here goes out as the caller, a page at a time.

// TimelineChangesMax is the most changes one answer lists, the newest kept.
const TimelineChangesMax = 50

// metadataListAccept asks the API server for a list's metadata only: no data, no stringData, no values.
const metadataListAccept = "application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io"

// argoApplications is where gitops_status reads Argo CD's Applications.
var argoApplications = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}

// argoApplicationPageSize: an Application carries the status of every object it deploys.
const argoApplicationPageSize = 50

// nodeStartupGrace: the conditions a new node reports fine in its first minutes are its start, not a change.
const nodeStartupGrace = 5 * time.Minute

// The sources of the changes view, as summary.by_source names them.
var timelineChangeSources = []string{"rollouts", "configmaps", "secrets", "helm", "hpas", "nodes", "pods", "argocd"}

// TimelineChange is one change: when, which object, and what changed from what to what.
type TimelineChange struct {
	When      string        `json:"when"`
	Kind      string        `json:"kind"`
	Name      string        `json:"name"`
	Namespace string        `json:"namespace,omitempty"`
	What      string        `json:"what"`
	From      interface{}   `json:"from,omitempty"`
	To        interface{}   `json:"to,omitempty"`
	By        string        `json:"by,omitempty"`
	Container string        `json:"container,omitempty"`
	Reason    string        `json:"reason,omitempty"`
	Changed   []FieldChange `json:"changed,omitempty"`
	Note      string        `json:"note,omitempty"`
	at        time.Time
}

// FieldChange is one field of a pod template that differs from the revision before: an image with both, any other
// field by its name, and for env, labels and annotations the keys added, removed or changed.
type FieldChange struct {
	Field       string   `json:"field"`
	Container   string   `json:"container,omitempty"`
	From        string   `json:"from,omitempty"`
	To          string   `json:"to,omitempty"`
	KeysAdded   []string `json:"keys_added,omitempty"`
	KeysRemoved []string `json:"keys_removed,omitempty"`
	KeysChanged []string `json:"keys_changed,omitempty"`
}

// TimelineChangesResult is the newest changes of a window, newest first, with how many there were by source and the
// sources that could not be read.
type TimelineChangesResult struct {
	Changes []TimelineChange       `json:"changes"`
	Summary map[string]interface{} `json:"summary"`
}

// changeSink gathers the changes of a window from its sources, keeping the newest max of them.
type changeSink struct {
	since, until time.Time
	max          int

	mu      sync.Mutex
	changes []TimelineChange
	total   int
	counts  map[string]int
	notRead map[string]string
	notes   map[string]string
	skipped map[string]string
}

func newChangeSink(since, until time.Time, most int) *changeSink {
	return &changeSink{since: since, until: until, max: most, counts: map[string]int{}, notRead: map[string]string{}, notes: map[string]string{}, skipped: map[string]string{}}
}

func (c *changeSink) in(t time.Time) bool {
	return !t.IsZero() && !t.Before(c.since) && !t.After(c.until)
}

// add counts a change of source and keeps it while it is among the newest.
func (c *changeSink) add(source string, ch TimelineChange) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total++
	c.counts[source]++
	c.changes = append(c.changes, ch)
	if len(c.changes) >= 4*c.max {
		c.keepNewest()
	}
}

// failed names a source that could not be read with why, the cluster's address left out (response.Public).
func (c *changeSink) failed(source string, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.notRead[source] = response.Public(err)
}

// skip says why a source was not read, which is not a zero either.
func (c *changeSink) skip(source, text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.skipped[source] = text
}

// note says why a source has nothing to count, which is not a zero either.
func (c *changeSink) note(source, text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.notes[source] = text
}

// keepNewest orders the changes newest first and keeps max of them; the caller holds mu or is the last one left.
func (c *changeSink) keepNewest() {
	sort.SliceStable(c.changes, func(i, j int) bool { return newerChange(c.changes[i], c.changes[j]) })
	if len(c.changes) > c.max {
		c.changes = c.changes[:c.max]
	}
}

// newerChange orders by time, the newest first, and changes at one time by namespace, kind, name and container.
func newerChange(a, b TimelineChange) bool {
	if !a.at.Equal(b.at) {
		return a.at.After(b.at)
	}
	if a.Namespace != b.Namespace {
		return a.Namespace < b.Namespace
	}
	if a.Kind != b.Kind {
		return a.Kind < b.Kind
	}
	if a.Name != b.Name {
		return a.Name < b.Name
	}
	return a.Container < b.Container
}

// result is the answer once every source is done: a source not read counts null, not zero.
func (c *changeSink) result() *TimelineChangesResult {
	c.keepNewest()
	changes := make([]TimelineChange, len(c.changes))
	for i, ch := range c.changes {
		ch.When = ch.at.UTC().Format(time.RFC3339)
		changes[i] = ch
	}
	bySource := map[string]interface{}{}
	for _, source := range timelineChangeSources {
		bySource[source] = c.counts[source]
	}
	for source := range c.notRead {
		bySource[source] = nil
	}
	for source := range c.notes {
		bySource[source] = nil
	}
	for source := range c.skipped {
		bySource[source] = nil
	}
	if _, refused := c.notRead["secrets"]; refused {
		bySource["helm"] = nil
	}
	summary := map[string]interface{}{
		"changes_total": c.total,
		"changes_shown": len(changes),
		"by_source":     bySource,
		"time_range": map[string]interface{}{
			"start": c.since.UTC().Format(time.RFC3339),
			"end":   c.until.UTC().Format(time.RFC3339),
		},
	}
	if len(c.notRead) > 0 {
		summary["not_read"] = c.notRead
	}
	if len(c.notes) > 0 {
		summary["notes"] = c.notes
	}
	if len(c.skipped) > 0 {
		summary["skipped"] = c.skipped
	}
	return &TimelineChangesResult{Changes: changes, Summary: summary}
}

// timelineChangesRunMax bounds one shared read of the changes, which goes on when the caller it started for leaves.
const timelineChangesRunMax = 60 * time.Second

// GetTimelineChanges lists what changed from since to until in namespace ("" for every namespace the caller reads, each
// of a limited grant's in turn), the newest limit of it: rollouts compared with the revision before, ConfigMap and Secret
// writes, Helm release revisions, HPA scales, node creations and condition changes, Argo CD syncs and container
// restarts. Callers asking the same window with the same identity and grant at one moment share one read
// (changesFlight): the same window is the same question, and the handler keeps the answer 30 s anyway.
func (s *Service) GetTimelineChanges(ctx context.Context, namespace string, since, until time.Time, limit int) (*TimelineChangesResult, error) {
	if s.clientsetCtx(ctx) == nil {
		return nil, errNotLoaded
	}
	key := s.clusterCacheKey(ctx, fmt.Sprintf("timeline-changes|%s|%d|%d|%d|%s", namespace, since.Unix(), until.Unix(), limit, strings.Join(scopeFromCtx(ctx), ",")))
	answer, err := sharedRun(ctx, &s.changesFlight, key, func(run context.Context) (interface{}, error) {
		return s.readTimelineChanges(run, namespace, since, until, limit)
	})
	if err != nil {
		return nil, err
	}
	return answer.(*TimelineChangesResult), nil
}

// sharedRun is read once for everyone asking key at one moment, on the first caller's context values but not its
// cancellation (bounded by timelineChangesRunMax), so one caller leaving fails no one else; each caller waits on its
// own context.
func sharedRun(ctx context.Context, group *singleflight.Group, key string, read func(context.Context) (interface{}, error)) (interface{}, error) {
	answers := group.DoChan(key, func() (interface{}, error) {
		run, cancel := context.WithTimeout(context.WithoutCancel(ctx), timelineChangesRunMax)
		defer cancel()
		return read(run)
	})
	select {
	case r := <-answers:
		return r.Val, r.Err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// readTimelineChanges reads the sources one after another, so one read has one list at a time with the cluster and holds
// at most one of bigReadSlots (eachPage takes it before a second page). A source that could not be read is in
// summary.not_read with why; when every namespaced source that was read was refused, that refusal is the answer.
// Without a namespace, a caller not limited to namespaces walks the cluster's pods only when it may list pods across
// the cluster; otherwise the restarts are skipped and summary.skipped says so.
func (s *Service) readTimelineChanges(ctx context.Context, namespace string, since, until time.Time, limit int) (*TimelineChangesResult, error) {
	sink := newChangeSink(since, until, limit)
	namespaced := []struct {
		source string
		read   func(ns string) error
	}{
		{"rollouts", func(ns string) error { return s.rolloutChangesIn(ctx, ns, sink) }},
		{"configmaps", func(ns string) error { return s.writeChangesIn(ctx, ns, "configmaps", "ConfigMap", sink) }},
		{"secrets", func(ns string) error { return s.writeChangesIn(ctx, ns, "secrets", "Secret", sink) }},
		{"hpas", func(ns string) error { return s.hpaChangesIn(ctx, ns, sink) }},
		{"pods", func(ns string) error { return s.restartChangesIn(ctx, ns, sink) }},
	}
	tried, refused := 0, 0
	var first error
	for _, src := range namespaced {
		if src.source == "pods" && namespace == "" && len(scopeFromCtx(ctx)) == 0 {
			if b := s.bundleForCtx(ctx); b != nil {
				if allowed, err := s.mayList(ctx, b, "pods", ""); err == nil && !allowed {
					sink.skip("pods", "the restarts of every namespace are read only for a caller who may list pods across the cluster; name a namespace")
					continue
				}
			}
		}
		tried++
		if err := eachCallerNamespace(ctx, namespace, src.read); err != nil {
			refused++
			if first == nil {
				first = err
			}
			sink.failed(src.source, err)
		}
	}
	if tried > 0 && refused == tried {
		return nil, first
	}
	if err := s.nodeChanges(ctx, sink); err != nil {
		sink.failed("nodes", err)
	}
	s.argoChanges(ctx, namespace, sink)
	return sink.result(), nil
}

// --- Rollouts ---

// revisionKey is the workload a revision belongs to.
type revisionKey struct{ kind, namespace, name string }

// revisionPrint is what a revision's pod template is compared by: its containers' names and images, the hash of each
// other field, and of env, labels and annotations a hash per key. No value is kept.
type revisionPrint struct {
	revision   int64
	created    time.Time
	containers []string
	images     map[string]string
	fields     map[string]uint64
	cfields    map[string]map[string]uint64
	env        map[string]map[string]uint64
	labels     map[string]uint64
	annots     map[string]uint64
}

// ownerRevisions are a workload's revisions created in the window and the newest one created before it.
type ownerRevisions struct {
	inWindow []*revisionPrint
	before   *revisionPrint
}

type revisionBook struct {
	since, until time.Time
	mu           sync.Mutex
	owners       map[revisionKey]*ownerRevisions
}

func newRevisionBook(since, until time.Time) *revisionBook {
	return &revisionBook{since: since, until: until, owners: map[revisionKey]*ownerRevisions{}}
}

// rolloutChangesIn compares each revision created in the window with the one before it of the same Deployment
// (ReplicaSets), StatefulSet or DaemonSet (ControllerRevisions), read a page at a time.
func (s *Service) rolloutChangesIn(ctx context.Context, namespace string, sink *changeSink) error {
	cs := s.clientsetCtx(ctx)
	book := newRevisionBook(sink.since, sink.until)
	err := eachRolloutPage(ctx, func(o metav1.ListOptions) (*appsv1.ReplicaSetList, error) {
		return cs.AppsV1().ReplicaSets(namespace).List(ctx, o)
	}, func(page *appsv1.ReplicaSetList) {
		for i := range page.Items {
			book.addReplicaSet(&page.Items[i])
		}
	})
	if err != nil {
		return fmt.Errorf("list replicasets: %w", err)
	}
	err = eachRolloutPage(ctx, func(o metav1.ListOptions) (*appsv1.ControllerRevisionList, error) {
		return cs.AppsV1().ControllerRevisions(namespace).List(ctx, o)
	}, func(page *appsv1.ControllerRevisionList) {
		for i := range page.Items {
			book.addControllerRevision(&page.Items[i])
		}
	})
	if err != nil {
		return fmt.Errorf("list controller revisions: %w", err)
	}
	book.emit(sink)
	return nil
}

func (b *revisionBook) addReplicaSet(rs *appsv1.ReplicaSet) {
	owner := metav1.GetControllerOf(rs)
	if owner == nil || owner.Kind != "Deployment" {
		return
	}
	revision, err := strconv.ParseInt(rs.Annotations["deployment.kubernetes.io/revision"], 10, 64)
	if err != nil {
		return
	}
	b.add(revisionKey{"Deployment", rs.Namespace, owner.Name}, revision, rs.CreationTimestamp.Time, &rs.Spec.Template)
}

func (b *revisionBook) addControllerRevision(cr *appsv1.ControllerRevision) {
	owner := metav1.GetControllerOf(cr)
	if owner == nil || (owner.Kind != "StatefulSet" && owner.Kind != "DaemonSet") || cr.Data.Raw == nil {
		return
	}
	var data struct {
		Spec struct {
			Template corev1.PodTemplateSpec `json:"template"`
		} `json:"spec"`
	}
	if json.Unmarshal(cr.Data.Raw, &data) != nil {
		return
	}
	b.add(revisionKey{owner.Kind, cr.Namespace, owner.Name}, cr.Revision, cr.CreationTimestamp.Time, &data.Spec.Template)
}

// add keeps a revision created in the window, or the newest created before it; one created after is neither.
func (b *revisionBook) add(key revisionKey, revision int64, created time.Time, tmpl *corev1.PodTemplateSpec) {
	if created.After(b.until) {
		return
	}
	inWindow := !created.Before(b.since)
	b.mu.Lock()
	defer b.mu.Unlock()
	o := b.owners[key]
	if o == nil {
		o = &ownerRevisions{}
		b.owners[key] = o
	}
	if inWindow {
		o.inWindow = append(o.inWindow, printTemplate(revision, created, tmpl))
		return
	}
	if o.before == nil || revision > o.before.revision {
		o.before = printTemplate(revision, created, tmpl)
	}
}

// emit writes each revision of the window as a change from the revision before it. A rollback gives an older
// ReplicaSet (or ControllerRevision) the next revision number and keeps its creation time, so it is not in the window:
// when one created before the window holds a higher revision than the window's first, the workload was rolled back to
// it after that rollout, which the first one's note says, and that first one has no revision before it to compare with.
func (b *revisionBook) emit(sink *changeSink) {
	for key, o := range b.owners {
		if len(o.inWindow) == 0 {
			continue
		}
		sort.Slice(o.inWindow, func(i, j int) bool { return o.inWindow[i].revision < o.inWindow[j].revision })
		prev := o.before
		rolledBack := prev != nil && prev.revision > o.inWindow[0].revision
		if rolledBack {
			prev = nil
		}
		for i, cur := range o.inWindow {
			ch := TimelineChange{at: cur.created, Kind: key.kind, Name: key.name, Namespace: key.namespace, What: "rollout", To: cur.revision}
			switch {
			case i == 0 && rolledBack:
				ch.Note = fmt.Sprintf("rolled back after this rollout: revision %d is an older template brought back, which keeps its creation time, so when is not known", o.before.revision)
			case prev == nil:
				ch.Note = "no earlier revision is kept, so nothing is compared"
			default:
				ch.From = prev.revision
				if ch.Changed = diffPrints(prev, cur); len(ch.Changed) == 0 {
					ch.Note = "the pod template is the same as the revision before"
				}
			}
			sink.add("rollouts", ch)
			prev = cur
		}
	}
}

// printTemplate hashes a pod template field by field. The labels a controller adds to tell its revisions apart are
// left out.
func printTemplate(revision int64, created time.Time, tmpl *corev1.PodTemplateSpec) *revisionPrint {
	p := &revisionPrint{
		revision: revision, created: created,
		images: map[string]string{}, cfields: map[string]map[string]uint64{}, env: map[string]map[string]uint64{},
		labels: map[string]uint64{}, annots: map[string]uint64{},
	}
	for k, v := range tmpl.Labels {
		if k != "pod-template-hash" && k != "controller-revision-hash" {
			p.labels[k] = hashString(v)
		}
	}
	for k, v := range tmpl.Annotations {
		p.annots[k] = hashString(v)
	}
	spec := tmpl.Spec
	containers := make([]corev1.Container, 0, len(spec.InitContainers)+len(spec.Containers))
	containers = append(append(containers, spec.InitContainers...), spec.Containers...)
	initCount := len(spec.InitContainers)
	spec.InitContainers, spec.Containers = nil, nil
	p.fields = hashFields(spec)
	for i, c := range containers {
		name := c.Name
		if i < initCount {
			name = "init:" + c.Name
		}
		p.containers = append(p.containers, name)
		p.images[name] = c.Image
		env := map[string]uint64{}
		for _, e := range c.Env {
			env[e.Name] = hashJSON(e)
		}
		p.env[name] = env
		c.Name, c.Image, c.Env = "", "", nil
		p.cfields[name] = hashFields(c)
	}
	return p
}

// diffPrints names what differs between two revisions' templates: containers added or removed, images, the other
// fields of the pod and of each container kept by both, and the keys of env, labels and annotations.
func diffPrints(prev, cur *revisionPrint) []FieldChange {
	var out []FieldChange
	if !slices.Equal(prev.containers, cur.containers) {
		out = append(out, FieldChange{Field: "containers", From: strings.Join(prev.containers, ","), To: strings.Join(cur.containers, ",")})
	}
	for _, name := range cur.containers {
		before, kept := prev.images[name]
		if !kept {
			continue
		}
		if before != cur.images[name] {
			out = append(out, FieldChange{Field: "image", Container: name, From: before, To: cur.images[name]})
		}
		if ch, ok := diffKeys("env", name, prev.env[name], cur.env[name]); ok {
			out = append(out, ch)
		}
		for _, field := range differentFields(prev.cfields[name], cur.cfields[name]) {
			out = append(out, FieldChange{Field: field, Container: name})
		}
	}
	for _, field := range differentFields(prev.fields, cur.fields) {
		out = append(out, FieldChange{Field: field})
	}
	if ch, ok := diffKeys("labels", "", prev.labels, cur.labels); ok {
		out = append(out, ch)
	}
	if ch, ok := diffKeys("annotations", "", prev.annots, cur.annots); ok {
		out = append(out, ch)
	}
	return out
}

// diffKeys names the keys added, removed and changed between two hashes per key.
func diffKeys(field, container string, prev, cur map[string]uint64) (FieldChange, bool) {
	ch := FieldChange{Field: field, Container: container}
	for k, h := range cur {
		if before, kept := prev[k]; !kept {
			ch.KeysAdded = append(ch.KeysAdded, k)
		} else if before != h {
			ch.KeysChanged = append(ch.KeysChanged, k)
		}
	}
	for k := range prev {
		if _, kept := cur[k]; !kept {
			ch.KeysRemoved = append(ch.KeysRemoved, k)
		}
	}
	sort.Strings(ch.KeysAdded)
	sort.Strings(ch.KeysRemoved)
	sort.Strings(ch.KeysChanged)
	return ch, len(ch.KeysAdded)+len(ch.KeysRemoved)+len(ch.KeysChanged) > 0
}

// differentFields are the fields set in one and not the other, or set to something else, in name order.
func differentFields(prev, cur map[string]uint64) []string {
	var out []string
	for k, h := range cur {
		if before, kept := prev[k]; !kept || before != h {
			out = append(out, k)
		}
	}
	for k := range prev {
		if _, kept := cur[k]; !kept {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// hashFields is a hash of each field of v as JSON writes it, by the field's JSON name.
func hashFields(v interface{}) map[string]uint64 {
	out := map[string]uint64{}
	raw, err := json.Marshal(v)
	if err != nil {
		return out
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return out
	}
	for k, field := range fields {
		out[k] = hashBytes(field)
	}
	return out
}

func hashJSON(v interface{}) uint64 {
	raw, _ := json.Marshal(v)
	return hashBytes(raw)
}

func hashString(v string) uint64 { return hashBytes([]byte(v)) }

func hashBytes(b []byte) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(b)
	return h.Sum64()
}

// --- ConfigMaps, Secrets and Helm releases ---

// writeChangesIn lists a namespace's ConfigMaps or Secrets as metadata only and writes each one last written in the
// window, with the field manager that wrote it. Helm keeps a release's revisions as Secrets (or ConfigMaps) of its own;
// those are written as the release's revisions instead.
func (s *Service) writeChangesIn(ctx context.Context, namespace, resource, kind string, sink *changeSink) error {
	cs := s.clientsetCtx(ctx)
	path := []string{"/api", "v1"}
	if namespace != "" {
		path = append(path, "namespaces", namespace)
	}
	path = append(path, resource)
	return eachPage(ctx, metav1.ListOptions{Limit: timelinePageSize}, func(o metav1.ListOptions) (*metav1.PartialObjectMetadataList, error) {
		req := cs.RESTClient().Get().AbsPath(path...).SetHeader("Accept", metadataListAccept).Param("limit", strconv.FormatInt(o.Limit, 10))
		if o.Continue != "" {
			req = req.Param("continue", o.Continue)
		}
		raw, err := tableBody(ctx, req)
		if err != nil {
			return nil, fmt.Errorf("list %s: %w", resource, err)
		}
		list := &metav1.PartialObjectMetadataList{}
		if err := json.Unmarshal(raw, list); err != nil {
			return nil, fmt.Errorf("list %s: unreadable metadata: %w", resource, err)
		}
		return list, nil
	}, func(page *metav1.PartialObjectMetadataList) {
		for i := range page.Items {
			meta := &page.Items[i].ObjectMeta
			if isHelmRelease(meta) {
				if ch, ok := helmRevisionChange(meta, sink); ok {
					sink.add("helm", ch)
				}
				continue
			}
			if ch, ok := writeChange(kind, meta, sink); ok {
				sink.add(resource, ch)
			}
		}
	})
}

// lastWrite is when an object was last written and by which field manager: the newest time of its managedFields, or
// its creation when none is newer. Only that last write can be known.
func lastWrite(meta *metav1.ObjectMeta) (time.Time, string) {
	at, by := meta.CreationTimestamp.Time, ""
	for _, f := range meta.ManagedFields {
		if f.Time != nil && !f.Time.Time.Before(at) {
			at, by = f.Time.Time, f.Manager
		}
	}
	return at, by
}

func writeChange(kind string, meta *metav1.ObjectMeta, sink *changeSink) (TimelineChange, bool) {
	at, by := lastWrite(meta)
	if !sink.in(at) {
		return TimelineChange{}, false
	}
	what := "written"
	if at.Sub(meta.CreationTimestamp.Time) < time.Second {
		what = "created"
	}
	return TimelineChange{at: at, Kind: kind, Name: meta.Name, Namespace: meta.Namespace, What: what, By: by}, true
}

// isHelmRelease: Helm's storage keeps each revision of a release as a Secret (or a ConfigMap) of its own.
func isHelmRelease(meta *metav1.ObjectMeta) bool {
	return meta.Labels["owner"] == "helm" && strings.HasPrefix(meta.Name, "sh.helm.release.v1.")
}

// helmRevisionChange is a Helm release revision made in the window, from the labels Helm's storage writes on it (name,
// version, status); its status is what it is now.
func helmRevisionChange(meta *metav1.ObjectMeta, sink *changeSink) (TimelineChange, bool) {
	if !sink.in(meta.CreationTimestamp.Time) {
		return TimelineChange{}, false
	}
	ch := TimelineChange{at: meta.CreationTimestamp.Time, Kind: "HelmRelease", Name: meta.Labels["name"], Namespace: meta.Namespace, What: "release revision"}
	if revision, err := strconv.Atoi(meta.Labels["version"]); err == nil {
		ch.To = revision
		if revision > 1 {
			ch.From = revision - 1
		}
	}
	if status := meta.Labels["status"]; status != "" {
		ch.Note = "status now " + status
	}
	return ch, true
}

// --- HPAs, nodes and restarts ---

// hpaChangesIn writes each HPA that last scaled in the window, to how many; earlier scales are in its events only.
func (s *Service) hpaChangesIn(ctx context.Context, namespace string, sink *changeSink) error {
	cs := s.clientsetCtx(ctx)
	return eachRolloutPage(ctx, func(o metav1.ListOptions) (*autoscalingv2.HorizontalPodAutoscalerList, error) {
		return cs.AutoscalingV2().HorizontalPodAutoscalers(namespace).List(ctx, o)
	}, func(page *autoscalingv2.HorizontalPodAutoscalerList) {
		for i := range page.Items {
			h := &page.Items[i]
			if h.Status.LastScaleTime == nil || !sink.in(h.Status.LastScaleTime.Time) {
				continue
			}
			sink.add("hpas", TimelineChange{
				at: h.Status.LastScaleTime.Time, Kind: "HorizontalPodAutoscaler", Name: h.Name, Namespace: h.Namespace,
				What: "scaled", To: h.Status.DesiredReplicas,
				Note: fmt.Sprintf("%d running now, of %s %s", h.Status.CurrentReplicas, h.Spec.ScaleTargetRef.Kind, h.Spec.ScaleTargetRef.Name),
			})
		}
	})
}

// nodeFact is what the changes read of a node: its creation and its conditions' types, statuses, reasons and times. The
// overview informers keep no condition times (stripNode), so the nodes are listed as the caller.
type nodeFact struct {
	name       string
	created    time.Time
	conditions []corev1.NodeCondition
}

// nodeChanges writes the nodes created in the window and each node condition that changed in it; a node gone is in its
// events only. One list of the nodes serves every changes read of the same identity at that moment, whatever its window
// (nodeFacts).
func (s *Service) nodeChanges(ctx context.Context, sink *changeSink) error {
	facts, err := s.nodeFacts(ctx)
	if err != nil {
		return fmt.Errorf("list nodes: %w", err)
	}
	for i := range facts {
		nodeChangesOf(&facts[i], sink)
	}
	return nil
}

func (s *Service) nodeFacts(ctx context.Context) ([]nodeFact, error) {
	facts, err := sharedRun(ctx, &s.changesFlight, s.clusterCacheKey(ctx, "timeline-changes-nodes"), func(run context.Context) (interface{}, error) {
		cs := s.clientsetCtx(run)
		var out []nodeFact
		err := eachRolloutPage(run, func(o metav1.ListOptions) (*corev1.NodeList, error) {
			return cs.CoreV1().Nodes().List(run, o)
		}, func(page *corev1.NodeList) {
			for i := range page.Items {
				n := &page.Items[i]
				fact := nodeFact{name: n.Name, created: n.CreationTimestamp.Time}
				for _, c := range n.Status.Conditions {
					fact.conditions = append(fact.conditions, corev1.NodeCondition{Type: c.Type, Status: c.Status, Reason: c.Reason, LastTransitionTime: c.LastTransitionTime})
				}
				out = append(out, fact)
			}
		})
		return out, err
	})
	if err != nil {
		return nil, err
	}
	return facts.([]nodeFact), nil
}

func nodeChangesOf(n *nodeFact, sink *changeSink) {
	isNew := sink.in(n.created)
	if isNew {
		sink.add("nodes", TimelineChange{at: n.created, Kind: "Node", Name: n.name, What: "created"})
	}
	for _, c := range n.conditions {
		at := c.LastTransitionTime.Time
		if !sink.in(at) || (isNew && nodeConditionFine(c) && at.Sub(n.created) < nodeStartupGrace) {
			continue
		}
		sink.add("nodes", TimelineChange{at: at, Kind: "Node", Name: n.name, What: "condition " + string(c.Type), To: string(c.Status), Reason: c.Reason})
	}
}

// nodeConditionFine: Ready is True, any other condition False.
func nodeConditionFine(c corev1.NodeCondition) bool {
	if c.Type == corev1.NodeReady {
		return c.Status == corev1.ConditionTrue
	}
	return c.Status == corev1.ConditionFalse
}

// restartChangesIn writes each container whose last termination ended in the window, with its reason and exit code, as
// the issues read them; earlier ones are not kept by the pod.
func (s *Service) restartChangesIn(ctx context.Context, namespace string, sink *changeSink) error {
	err := eachPod(ctx, s.clientsetCtx(ctx).CoreV1(), namespace, metav1.ListOptions{}, func(p *corev1.Pod) {
		statuses := make([]corev1.ContainerStatus, 0, len(p.Status.InitContainerStatuses)+len(p.Status.ContainerStatuses))
		statuses = append(append(statuses, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...)
		for _, c := range statuses {
			t := c.LastTerminationState.Terminated
			if t == nil || !sink.in(t.FinishedAt.Time) {
				continue
			}
			reason := t.Reason
			if reason == "" {
				reason = "Terminated"
			}
			sink.add("pods", TimelineChange{
				at: t.FinishedAt.Time, Kind: "Pod", Name: p.Name, Namespace: p.Namespace, What: "container restarted",
				Container: c.Name, Reason: fmt.Sprintf("%s (exit %d)", reason, t.ExitCode), Note: fmt.Sprintf("%d restarts", c.RestartCount),
			})
		}
	})
	if err != nil {
		return fmt.Errorf("list pods: %w", err)
	}
	return nil
}

// --- Argo CD ---

// argoChanges writes the syncs of the window from each Argo CD Application's history, where gitops_status reads them:
// the Applications that deploy to namespace or live in it (every one when namespace is ""), each of a limited grant's
// namespaces in turn. A cluster without Argo CD says so in summary.notes.
func (s *Service) argoChanges(ctx context.Context, namespace string, sink *changeSink) {
	dyn := s.dynamicCtx(ctx)
	if dyn == nil {
		return
	}
	read := func(ns string) error {
		return eachPage(ctx, metav1.ListOptions{Limit: argoApplicationPageSize}, func(o metav1.ListOptions) (*unstructured.UnstructuredList, error) {
			return dyn.Resource(argoApplications).Namespace(ns).List(ctx, o)
		}, func(page *unstructured.UnstructuredList) {
			for i := range page.Items {
				argoChangesOf(&page.Items[i], namespace, sink)
			}
		})
	}
	err := eachCallerNamespace(ctx, "", read)
	switch {
	case err == nil:
	case apierrors.IsNotFound(err):
		sink.note("argocd", "Argo CD Applications are not served in this cluster (no applications.argoproj.io)")
	default:
		sink.failed("argocd", fmt.Errorf("list applications.argoproj.io: %w", err))
	}
}

func argoChangesOf(app *unstructured.Unstructured, namespace string, sink *changeSink) {
	dest, _, _ := unstructured.NestedString(app.Object, "spec", "destination", "namespace")
	if namespace != "" && dest != namespace && app.GetNamespace() != namespace {
		return
	}
	note := ""
	if dest != "" {
		note = "deploys to " + dest
	}
	history, _, _ := unstructured.NestedSlice(app.Object, "status", "history")
	prev := ""
	for _, h := range history {
		entry, _ := h.(map[string]interface{})
		revision := argoRevision(entry)
		at, _ := entry["deployedAt"].(string)
		if t, err := time.Parse(time.RFC3339, at); err == nil && sink.in(t) {
			ch := TimelineChange{at: t, Kind: "Application", Name: app.GetName(), Namespace: app.GetNamespace(), What: "synced", To: revision, Note: note}
			if prev != "" {
				ch.From = prev
			}
			sink.add("argocd", ch)
		}
		prev = revision
	}
	// a sync that failed adds no history
	phase, _, _ := unstructured.NestedString(app.Object, "status", "operationState", "phase")
	if phase != "Failed" && phase != "Error" {
		return
	}
	finished, _, _ := unstructured.NestedString(app.Object, "status", "operationState", "finishedAt")
	if t, err := time.Parse(time.RFC3339, finished); err == nil && sink.in(t) {
		revision, _, _ := unstructured.NestedString(app.Object, "status", "operationState", "syncResult", "revision")
		ch := TimelineChange{at: t, Kind: "Application", Name: app.GetName(), Namespace: app.GetNamespace(), What: "sync " + strings.ToLower(phase), Reason: phase, Note: note}
		if revision != "" {
			ch.To = shortGitRevision(revision)
		}
		sink.add("argocd", ch)
	}
}

// argoRevision is a history entry's revision, or its sources' revisions joined.
func argoRevision(entry map[string]interface{}) string {
	if r, _ := entry["revision"].(string); r != "" {
		return shortGitRevision(r)
	}
	list, _ := entry["revisions"].([]interface{})
	parts := make([]string, 0, len(list))
	for _, r := range list {
		if s, _ := r.(string); s != "" {
			parts = append(parts, shortGitRevision(s))
		}
	}
	return strings.Join(parts, ",")
}

// shortGitRevision is a commit's first 7 characters, as git prints it; a chart version or a tag stays whole.
func shortGitRevision(r string) string {
	if len(r) != 40 {
		return r
	}
	for _, c := range r {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return r
		}
	}
	return r[:7]
}
