package logsearch

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Request is one search, after the caller is authorized for the cluster and
// namespace. An empty Namespace searches every namespace.
type Request struct {
	Cluster      string
	Namespace    string
	Pod          string
	Container    string
	WorkloadKind string
	WorkloadName string
	Text         string
	Regex        bool
	IgnoreCase   bool
	Start        time.Time
	End          time.Time
	Limit        int
	Forward      bool
}

// MaxTextLength caps the search text.
const MaxTextLength = 256

var (
	dnsLabel     = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	dnsSubdomain = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)
)

// workloadPods is the pod name a workload's controller generates, after the
// workload name: Deployment → ReplicaSet hash + suffix, StatefulSet → ordinal,
// DaemonSet / ReplicaSet → suffix, Job → [index-]suffix, CronJob → schedule
// time + Job's [index-]suffix. Stream selector regexes match the whole value.
var workloadPods = map[string]string{
	"Deployment":  `-[a-z0-9]{1,10}-[a-z0-9]{5}`,
	"StatefulSet": `-[0-9]+`,
	"DaemonSet":   `-[a-z0-9]{5}`,
	"ReplicaSet":  `-[a-z0-9]{5}`,
	"Job":         `(-[0-9]+)?-[a-z0-9]{5}`,
	"CronJob":     `-[0-9]+(-[0-9]+)?-[a-z0-9]{5}`,
}

// Normalize checks the request and fills the defaults: the range (default
// window, at most MaxRange, end not in the future) and the line limit.
func (c Config) Normalize(req *Request, now time.Time) error {
	if req.Namespace != "" && (len(req.Namespace) > 63 || !dnsLabel.MatchString(req.Namespace)) {
		return fmt.Errorf("invalid namespace %q", req.Namespace)
	}
	if req.Pod != "" && (len(req.Pod) > 253 || !dnsSubdomain.MatchString(req.Pod)) {
		return fmt.Errorf("invalid pod name %q", req.Pod)
	}
	if req.Container != "" && (len(req.Container) > 63 || !dnsLabel.MatchString(req.Container)) {
		return fmt.Errorf("invalid container name %q", req.Container)
	}
	if req.WorkloadKind != "" || req.WorkloadName != "" {
		if _, ok := workloadPods[req.WorkloadKind]; !ok {
			return fmt.Errorf("workload_kind must be one of Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob")
		}
		if len(req.WorkloadName) > 253 || !dnsSubdomain.MatchString(req.WorkloadName) {
			return fmt.Errorf("invalid workload name %q", req.WorkloadName)
		}
		if req.Pod != "" {
			return fmt.Errorf("pod and workload are exclusive")
		}
		if req.Namespace == "" {
			return fmt.Errorf("a workload search needs its namespace")
		}
	}
	if len(req.Text) > MaxTextLength {
		return fmt.Errorf("search text is longer than %d characters", MaxTextLength)
	}
	if req.Regex && req.Text != "" {
		if _, err := regexp.Compile(req.Text); err != nil {
			return fmt.Errorf("invalid regular expression: %v", err)
		}
	}

	if req.End.IsZero() || req.End.After(now) {
		req.End = now
	}
	if req.Start.IsZero() {
		req.Start = req.End.Add(-c.DefaultRange)
	}
	if !req.Start.Before(req.End) {
		return fmt.Errorf("start must be before end")
	}
	if req.End.Sub(req.Start) > c.MaxRange {
		return fmt.Errorf("the range is longer than %s", c.MaxRange)
	}
	if req.Limit <= 0 || req.Limit > c.MaxLines {
		req.Limit = c.MaxLines
	}
	return nil
}

// LogQL builds the Loki query for req on cluster value clusterValue. Every
// user value is a quoted literal; the cluster matcher (when the store has a
// cluster label) and a namespace matcher are always present.
func (c Config) LogQL(req Request, clusterValue string) string {
	var m []string
	if c.Labels.Cluster != "" {
		m = append(m, c.Labels.Cluster+"="+strconv.Quote(clusterValue))
	}
	if req.Namespace != "" {
		m = append(m, c.Labels.Namespace+"="+strconv.Quote(req.Namespace))
	} else {
		m = append(m, c.Labels.Namespace+`=~".+"`)
	}
	switch {
	case req.Pod != "":
		m = append(m, c.Labels.Pod+"="+strconv.Quote(req.Pod))
	case req.WorkloadKind != "":
		m = append(m, c.Labels.Pod+"=~"+strconv.Quote(regexp.QuoteMeta(req.WorkloadName)+workloadPods[req.WorkloadKind]))
	}
	if req.Container != "" {
		m = append(m, c.Labels.Container+"="+strconv.Quote(req.Container))
	}
	q := "{" + strings.Join(m, ", ") + "}"
	switch {
	case req.Text == "":
	case req.Regex && req.IgnoreCase:
		q += " |~ " + strconv.Quote("(?i)"+req.Text)
	case req.Regex:
		q += " |~ " + strconv.Quote(req.Text)
	case req.IgnoreCase:
		q += " |~ " + strconv.Quote("(?i)"+regexp.QuoteMeta(req.Text))
	default:
		q += " |= " + strconv.Quote(req.Text)
	}
	return q
}
