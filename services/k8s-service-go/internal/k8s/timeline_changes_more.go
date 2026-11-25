package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The changes view's further sources (chart ai.timelineChangesMore): Jobs made, NetworkPolicy and Service writes and
// replica counts set, in a namespace named only. Each is listed as the caller and as metadata only, so what is known of a
// write is its time, its field manager and the names of the fields that manager sets (managedFields), never a value. An
// entry counts by its own time when that is in the window: one in the future (another clock's) is left out and does not
// hide one before it. A namespace costs four lists more — Jobs, NetworkPolicies, Services, Deployments — and a fifth,
// StatefulSets, where its revisions name one or could not be read.
//
// The API server keeps who scaled a workload through its scale subresource and not when (the entry has no time, as
// apimachinery's ScaleHandler writes it), so when is taken from the ReplicaSets, which the rollouts read already: the
// controller that carried the scale out wrote the newest one's count. A StatefulSet keeps neither.

// timelineMoreChangeSources are the further sources as summary.by_source names them.
var timelineMoreChangeSources = []string{"jobs", "networkpolicies", "services", "deployment_replicas", "statefulset_replicas"}

const (
	// jobRowsMax is the most Jobs one answer lists, so that a batch of them leaves room for the other changes, and
	// cronJobRowsMax the most of one CronJob, the three finished and the one failed it keeps by default. All are counted.
	jobRowsMax     = 15
	cronJobRowsMax = 4

	// rolloutOfAWrite is how soon after a write of a workload its controller made a revision or set a ReplicaSet's count
	// for it, and within which the counts of a rollout's ReplicaSets are set one after another at its end.
	rolloutOfAWrite = time.Minute

	// desiredReplicasAnnotation is where the Deployment controller keeps spec.replicas on its ReplicaSets.
	desiredReplicasAnnotation = "deployment.kubernetes.io/desired-replicas"

	// changedNotKept: managedFields keeps what a manager sets and when it last wrote, not what that write changed.
	changedNotKept = "what this write changed is not kept"

	// hpaFieldManager scales as the HPA controller does: the kube-controller-manager.
	hpaFieldManager = "kube-controller-manager"
)

// moreChanges is what the further sources use of the ones read before them.
type moreChanges struct {
	rollouts  *revisionBook        // nil when the rollouts could not be read
	hpaScaled map[revisionKey]bool // the workloads whose HPA's last scale is listed
}

// deploymentReplicas is what a Deployment's ReplicaSets say of its replica count: the desired count on the newest
// revision's, when that one was made and its count last set, and, when others are kept, until when the pods one of them
// gave up could have been ending: its count's last set and their termination grace. A rollout that waits for them sets
// the newest one's count after that.
type deploymentReplicas struct {
	revision    int64
	desired     int
	said        bool
	made, set   time.Time
	grace       time.Duration
	others      bool
	othersUntil time.Time
}

// other keeps that a ReplicaSet that is not the newest had its count set.
func (d *deploymentReplicas) other(set time.Time, grace time.Duration) {
	d.others = true
	if until := set.Add(grace); !set.IsZero() && until.After(d.othersUntil) {
		d.othersUntil = until
	}
}

// GetTimelineChangesMore is GetTimelineChanges with the further sources.
func (s *Service) GetTimelineChangesMore(ctx context.Context, namespace string, since, until time.Time, limit int) (*TimelineChangesResult, error) {
	return s.timelineChanges(ctx, namespace, since, until, limit, true)
}

// moreChangeSources are the further sources of namespace; without one they are skipped, and nothing more is listed.
func (s *Service) moreChangeSources(ctx context.Context, namespace string, sink *changeSink) []changeSource {
	if namespace == "" {
		for _, source := range timelineMoreChangeSources {
			sink.skip(source, "read in a named namespace only")
		}
		return nil
	}
	sink.more = &moreChanges{hpaScaled: map[revisionKey]bool{}}
	sources := []changeSource{
		{"jobs", func(ns string) error { return s.jobChangesIn(ctx, ns, sink) }},
		{"networkpolicies", func(ns string) error {
			return s.specChangesIn(ctx, ns, []string{"/apis", "networking.k8s.io", "v1"}, "networkpolicies", "NetworkPolicy", nil, sink)
		}},
		{"services", func(ns string) error {
			return s.specChangesIn(ctx, ns, []string{"/api", "v1"}, "services", "Service", []string{"ports", "selector"}, sink)
		}},
		{"deployment_replicas", func(ns string) error {
			return s.replicaChangesIn(ctx, ns, "deployments", "Deployment", "deployment_replicas", sink)
		}},
		{"statefulset_replicas", func(ns string) error {
			if !sink.more.mayHave("StatefulSet") {
				return nil
			}
			return s.replicaChangesIn(ctx, ns, "statefulsets", "StatefulSet", "statefulset_replicas", sink)
		}},
	}
	for i, src := range sources {
		sources[i].read = func(ns string) error {
			if err := src.read(ns); err != nil {
				return fmt.Errorf("not readable: %w", err)
			}
			return nil
		}
	}
	return sources
}

// specFields are the names of the spec fields an entry's manager sets, in name order; what is under them is not read.
func specFields(f *metav1.ManagedFieldsEntry) []string { return ownedFields(f, "f:spec") }

// ownedFields are the names of the fields an entry's manager sets under one of the object's.
func ownedFields(f *metav1.ManagedFieldsEntry, under string) []string {
	var top, fields map[string]json.RawMessage
	if json.Unmarshal(f.FieldsV1.GetRawBytes(), &top) != nil || json.Unmarshal(top[under], &fields) != nil {
		return nil
	}
	var out []string
	for key := range fields {
		if name, ok := strings.CutPrefix(key, "f:"); ok {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// setsNothingElse: an entry's manager sets one field under one of the object's and nothing else, labels included.
func setsNothingElse(f *metav1.ManagedFieldsEntry, under, field string) bool {
	var top, fields map[string]json.RawMessage
	if json.Unmarshal(f.FieldsV1.GetRawBytes(), &top) != nil || json.Unmarshal(top[under], &fields) != nil {
		return false
	}
	_, sets := fields[field]
	return sets && len(top) == 1 && len(fields) == 1
}

// addNote joins what a change's note says.
func (c *TimelineChange) addNote(text string) {
	if c.Note != "" {
		text = c.Note + "; " + text
	}
	c.Note = text
}

// --- Jobs ---

// jobRuns are the Jobs of one CronJob, or every Job of none: the newest of them, how many and the first's time.
type jobRuns struct {
	newest []TimelineChange
	most   int
	count  int
	first  time.Time
}

func (j *jobRuns) add(ch TimelineChange) {
	if j.count++; j.first.IsZero() || ch.at.Before(j.first) {
		j.first = ch.at
	}
	j.newest = append(j.newest, ch)
	if len(j.newest) >= 4*j.most {
		j.keepNewest()
	}
}

func (j *jobRuns) keepNewest() {
	sort.SliceStable(j.newest, func(a, b int) bool { return newerChange(j.newest[a], j.newest[b]) })
	if len(j.newest) > j.most {
		j.newest = j.newest[:j.most]
	}
}

// jobChangesIn writes the Jobs made in the window, the newest of each CronJob and of all, and counts every one.
func (s *Service) jobChangesIn(ctx context.Context, namespace string, sink *changeSink) error {
	byCronJob := map[string]*jobRuns{}
	err := s.eachMetadataIn(ctx, []string{"/apis", "batch", "v1"}, namespace, "jobs", func(meta *metav1.ObjectMeta) {
		if !sink.in(meta.CreationTimestamp.Time) {
			return
		}
		ch, cronJob := jobChange(meta)
		runs := byCronJob[cronJob]
		if runs == nil {
			runs = &jobRuns{most: cronJobRowsMax}
			if cronJob == "" {
				runs.most = jobRowsMax
			}
			byCronJob[cronJob] = runs
		}
		runs.add(ch)
	})
	if err != nil {
		return err
	}
	listed := &jobRuns{most: jobRowsMax}
	total := 0
	for cronJob, runs := range byCronJob {
		total += runs.count
		runs.keepNewest()
		if cronJob != "" && runs.count > len(runs.newest) {
			runs.newest[0].addNote(fmt.Sprintf("%d Jobs of this CronJob in the window, the first at %s; at most the newest %d are listed",
				runs.count, runs.first.UTC().Format(time.RFC3339), cronJobRowsMax))
		}
		listed.newest = append(listed.newest, runs.newest...)
	}
	listed.keepNewest()
	sink.addOf("jobs", listed.newest, total)
	return nil
}

// jobChange is a Job made in the window and the CronJob whose run it is, "" for none: by that CronJob, another controller
// or the field manager that created it. A Job whose status has no start time (a suspended one) says so.
func jobChange(meta *metav1.ObjectMeta) (TimelineChange, string) {
	ch := TimelineChange{at: meta.CreationTimestamp.Time, Kind: "Job", Name: meta.Name, Namespace: meta.Namespace, What: "created"}
	cronJob := ""
	if owner := metav1.GetControllerOf(meta); owner != nil {
		ch.By = owner.Kind + " " + owner.Name
		if owner.Kind == "CronJob" {
			cronJob = owner.Name
			if meta.Annotations["cronjob.kubernetes.io/instantiate"] == "manual" {
				ch.addNote("run by hand")
			}
		}
	}
	started := len(meta.ManagedFields) == 0 // nothing says it did not
	for i := range meta.ManagedFields {
		f := &meta.ManagedFields[i]
		if ch.By == "" && f.Subresource == "" && f.Time != nil && f.Time.Sub(ch.at).Abs() < time.Second {
			ch.By = f.Manager
		}
		started = started || slices.Contains(ownedFields(f, "f:status"), "startTime")
	}
	if !started {
		ch.addNote("its status has no start time")
	}
	return ch, cronJob
}

// addOf keeps rows of source as add does and counts total changes, those not among the rows too.
func (c *changeSink) addOf(source string, rows []TimelineChange, total int) {
	for _, ch := range rows {
		c.add(source, ch)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += total - len(rows)
	c.counts[source] += total - len(rows)
}

// --- NetworkPolicies and Services ---

// specChangesIn writes each object of a kind created in the window or last written in it by a manager that sets one of
// fields of its spec (any when fields is nil). A write by a manager that sets none of them (kubectl label, a status) is
// no change of it; one by a manager that sets them and labels too (helm, kubectl apply) is one, whatever it changed, and
// its note says that what it changed is not kept.
func (s *Service) specChangesIn(ctx context.Context, namespace string, api []string, resource, kind string, fields []string, sink *changeSink) error {
	return s.eachMetadataIn(ctx, api, namespace, resource, func(meta *metav1.ObjectMeta) {
		if ch, ok := specChange(kind, meta, fields, sink); ok {
			sink.add(resource, ch)
		}
	})
}

func specChange(kind string, meta *metav1.ObjectMeta, fields []string, sink *changeSink) (TimelineChange, bool) {
	ch := TimelineChange{Kind: kind, Name: meta.Name, Namespace: meta.Namespace}
	var sets []string
	for i := range meta.ManagedFields {
		f := &meta.ManagedFields[i]
		if f.Subresource != "" || f.Time == nil || !sink.in(f.Time.Time) || f.Time.Time.Before(ch.at) {
			continue
		}
		owned := specFields(f)
		if fields != nil {
			owned = slices.DeleteFunc(owned, func(name string) bool { return !slices.Contains(fields, name) })
		}
		if len(owned) > 0 {
			ch.at, ch.By, sets = f.Time.Time, f.Manager, owned
		}
	}
	created := meta.CreationTimestamp.Time
	switch {
	case ch.at.IsZero() && !sink.in(created):
		return ch, false
	case ch.at.IsZero():
		ch.at, ch.What = created, "created"
	case ch.at.Sub(created) < time.Second:
		ch.What = "created"
	default:
		ch.What = "written"
		ch.Note = "its manager sets " + strings.Join(sets, ", ") + "; " + changedNotKept
	}
	return ch, true
}

// --- Replica counts ---

func (s *Service) replicaChangesIn(ctx context.Context, namespace, resource, kind, source string, sink *changeSink) error {
	return s.eachMetadataIn(ctx, []string{"/apis", "apps", "v1"}, namespace, resource, func(meta *metav1.ObjectMeta) {
		if ch, ok := replicaChange(kind, meta, sink); ok {
			sink.add(source, ch)
		}
	})
}

// replicaChange is the last write in the window by a manager that sets a workload's replica count: through the scale
// subresource (kubectl scale, an autoscaler), by an update of a manager that sets nothing else of the object, or by one
// whose write may have been of another field, a label too, which its note says. A scale whose HPA is listed and a write
// that made a revision, which is a rollout, are not said twice; one at its creation is the creation. To is the count
// now, kept by a Deployment's newest ReplicaSet.
func replicaChange(kind string, meta *metav1.ObjectMeta, sink *changeSink) (TimelineChange, bool) {
	key := revisionKey{kind, meta.Namespace, meta.Name}
	var ch TimelineChange
	for i := range meta.ManagedFields {
		f := &meta.ManagedFields[i]
		scale := f.Subresource == "scale"
		if f.Subresource != "" && !scale {
			continue
		}
		var at time.Time
		switch {
		case f.Time != nil:
			at = f.Time.Time
		case scale:
			at = sink.more.scaledAt(key, meta)
		}
		if !sink.in(at) || at.Before(ch.at) {
			continue
		}
		spec := specFields(f)
		if !slices.Contains(spec, "replicas") {
			continue
		}
		write := TimelineChange{at: at, Kind: kind, Name: meta.Name, Namespace: meta.Namespace, By: f.Manager}
		switch {
		case scale:
			if f.Manager == hpaFieldManager && sink.more.hpaScaled[key] {
				continue
			}
			write.What = "scaled"
			if f.Time == nil {
				write.Note = "a scale keeps no time: when its ReplicaSet's count was set"
			}
		case at.Sub(meta.CreationTimestamp.Time) < time.Second:
			continue
		case f.Operation == metav1.ManagedFieldsOperationUpdate && setsNothingElse(f, "f:spec", "f:replicas"):
			write.What, write.Note = "replicas written", "its manager sets nothing else"
		case slices.Contains(spec, "template") && sink.more.rolledOut(key, at):
			continue
		default: // an apply that gives a field up moves the time too
			write.What, write.Note = "written", "its manager sets replicas; "+changedNotKept
		}
		ch = write
	}
	if ch.at.IsZero() {
		return ch, false
	}
	if d, kept := sink.more.replicasOf(key); kept && d.said {
		if ch.What == "written" {
			ch.addNote(fmt.Sprintf("%d replicas now", d.desired))
		} else {
			ch.To = d.desired
		}
	}
	return ch, true
}

// keepReplicas keeps what a Deployment's ReplicaSet says of its replica count.
func (b *revisionBook) keepReplicas(key revisionKey, revision int64, rs *appsv1.ReplicaSet) {
	grace := int64(corev1.DefaultTerminationGracePeriodSeconds)
	if given := rs.Spec.Template.Spec.TerminationGracePeriodSeconds; given != nil {
		grace = *given
	}
	wait := time.Duration(grace) * time.Second
	set := b.countSet(&rs.ObjectMeta, wait)
	b.mu.Lock()
	defer b.mu.Unlock()
	d, seen := b.replicas[key]
	if seen && revision < d.revision {
		d.other(set, wait)
		b.replicas[key] = d
		return
	}
	if seen {
		d.other(d.set, d.grace)
	}
	d.revision, d.made, d.set, d.grace = revision, rs.CreationTimestamp.Time, set, wait
	n, err := strconv.Atoi(rs.Annotations[desiredReplicasAnnotation])
	d.desired, d.said = n, err == nil
	b.replicas[key] = d
}

// countSet is when the controller that sets a ReplicaSet's count last wrote it, zero when that and the grace of its pods
// were over too long before the window to matter in it.
func (b *revisionBook) countSet(meta *metav1.ObjectMeta, grace time.Duration) time.Time {
	var at time.Time
	matters := b.since.Add(-rolloutOfAWrite - grace)
	for i := range meta.ManagedFields {
		f := &meta.ManagedFields[i]
		if f.Subresource == "" && f.Time != nil && f.Time.After(at) && f.Time.After(matters) && slices.Contains(specFields(f), "replicas") {
			at = f.Time.Time
		}
	}
	return at
}

func (m *moreChanges) replicasOf(key revisionKey) (deploymentReplicas, bool) {
	if m.rollouts == nil {
		return deploymentReplicas{}, false
	}
	d, kept := m.rollouts.replicas[key]
	return d, kept
}

// scaledAt is when a workload scaled through its scale subresource had its newest ReplicaSet's count set, zero when no
// ReplicaSet says so or a rollout or another write of the workload may be why its controller wrote it then. Where a
// later revision's older ReplicaSets are not kept (revisionHistoryLimit 0) and it was made in the window, nothing says
// when that rollout ended.
func (m *moreChanges) scaledAt(key revisionKey, meta *metav1.ObjectMeta) time.Time {
	d, kept := m.replicasOf(key)
	if !kept || d.set.Sub(d.made) <= rolloutOfAWrite || d.set.Sub(d.othersUntil) <= rolloutOfAWrite {
		return time.Time{}
	}
	if !d.others && d.revision > 1 && !d.made.Before(m.rollouts.since) {
		return time.Time{}
	}
	for i := range meta.ManagedFields {
		if f := &meta.ManagedFields[i]; f.Subresource == "" && f.Time != nil && madeSoonAfter(d.set, f.Time.Time) {
			return time.Time{}
		}
	}
	return d.set
}

// madeSoonAfter: what a controller made at then may be of a write at t.
func madeSoonAfter(then, t time.Time) bool {
	after := then.Sub(t)
	return after > -time.Second && after <= rolloutOfAWrite
}

// rolledOut: a revision of the workload was made with the write at t.
func (m *moreChanges) rolledOut(key revisionKey, t time.Time) bool {
	if m.rollouts == nil || m.rollouts.owners[key] == nil {
		return false
	}
	return slices.ContainsFunc(m.rollouts.owners[key].inWindow, func(r *revisionPrint) bool { return madeSoonAfter(r.created, t) })
}

// mayHave: the namespace has a workload of kind as far as its revisions say, or they could not be read.
func (m *moreChanges) mayHave(kind string) bool {
	if m.rollouts == nil {
		return true
	}
	for key := range m.rollouts.owners {
		if key.kind == kind {
			return true
		}
	}
	return false
}
