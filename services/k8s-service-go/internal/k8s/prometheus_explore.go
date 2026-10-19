package k8s

// Finding what a cluster's Prometheus holds before querying it: metric names
// and metadata, label names and values, alerting and recording rules with
// their active alerts, and scrape targets. Same sources and the same cluster
// scoping as the queries (prometheus_source.go): a shared store only answers
// with this cluster's series.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/prometheus/promql/parser"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

var (
	// ErrPrometheusUpstream: the metrics store answered with an error (502 to the caller).
	ErrPrometheusUpstream = errors.New("metrics store error")
	// ErrPrometheusNotServed: the store has no such API (a VictoriaMetrics without
	// -vmalert.proxyURL has no rules); the caller gets 404 "not served".
	ErrPrometheusNotServed = errors.New("not served by this metrics store")
	// ErrBadSelector: a selector argument that is not a plain series selector.
	ErrBadSelector = errors.New("bad series selector")
)

const exploreWindow = time.Hour

// promGetData calls one Prometheus API path on the cluster's source and
// returns the "data" member of the reply.
func (s *Service) promGetData(ctx context.Context, src *promSource, promPath string) (json.RawMessage, error) {
	var body []byte
	if src.ext != nil {
		b, code, err := src.ext.do(ctx, promPath)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrPrometheusUpstream, err)
		}
		if code == http.StatusNotFound {
			return nil, fmt.Errorf("%w: %s", ErrPrometheusNotServed, strings.SplitN(promPath, "?", 2)[0])
		}
		if code != http.StatusOK {
			return nil, fmt.Errorf("%w (status %d): %s", ErrPrometheusUpstream, code, strings.TrimSpace(string(b[:min(len(b), 200)])))
		}
		body = b
	} else {
		info := src.proxy
		base := fmt.Sprintf("/api/v1/namespaces/%s/services/%s:%d/proxy", info.Namespace, info.Name, info.Port)
		sub, query, _ := strings.Cut(promPath, "?")
		req := s.clientsetCtx(ctx).CoreV1().RESTClient().Get().AbsPath(base).Suffix(sub)
		params, _ := url.ParseQuery(query)
		for k, vals := range params {
			for _, v := range vals {
				req = req.Param(k, v)
			}
		}
		b, err := req.Do(ctx).Raw()
		if err != nil {
			switch {
			case apierrors.IsForbidden(err), apierrors.IsUnauthorized(err):
				return nil, err
			case apierrors.IsNotFound(err):
				return nil, fmt.Errorf("%w: %s", ErrPrometheusNotServed, sub)
			}
			return nil, fmt.Errorf("%w: %v", ErrPrometheusUpstream, err)
		}
		body = b
	}
	var env struct {
		Status string          `json:"status"`
		Data   json.RawMessage `json:"data"`
		Error  string          `json:"error"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("%w: unreadable reply: %v", ErrPrometheusUpstream, err)
	}
	if env.Status != "success" {
		return nil, fmt.Errorf("%w: %s", ErrPrometheusUpstream, env.Error)
	}
	return env.Data, nil
}

// ValidSeriesSelector accepts a plain series selector (`up`, `x{a="b"}`,
// `{job="j"}`) — not an expression.
func ValidSeriesSelector(sel string) error {
	if strings.TrimSpace(sel) == "" {
		return nil
	}
	expr, err := promParser.ParseExpr(sel)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadSelector, err)
	}
	if _, ok := expr.(*parser.VectorSelector); !ok {
		return fmt.Errorf("%w: %q is an expression, not a series selector", ErrBadSelector, sel)
	}
	return nil
}

// matchParam is the match[] value for a find call: the caller's selector with
// the cluster matcher of a shared store, or that matcher alone; "" = none.
func (src *promSource) matchParam(sel string) (string, error) {
	sel = strings.TrimSpace(sel)
	if err := ValidSeriesSelector(sel); err != nil {
		return "", err
	}
	scopedStore := src.ext != nil && src.ext.labelValue != ""
	if sel == "" {
		if !scopedStore {
			return "", nil
		}
		return fmt.Sprintf(`{%s=%q}`, PrometheusClusterLabelName(), src.ext.labelValue), nil
	}
	return src.scoped(sel)
}

func windowParams(match string, since time.Duration, limit int) url.Values {
	if since <= 0 {
		since = exploreWindow
	}
	end := time.Now()
	q := url.Values{}
	q.Set("start", strconv.FormatInt(end.Add(-since).Unix(), 10))
	q.Set("end", strconv.FormatInt(end.Unix(), 10))
	if match != "" {
		q.Set("match[]", match)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	return q
}

// PromMetricInfo is one metric name with the metadata the store keeps for it.
type PromMetricInfo struct {
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
	Help string `json:"help,omitempty"`
	Unit string `json:"unit,omitempty"`
}

// PrometheusMetricNames lists metric names seen in the last hour whose name
// contains pattern (case-insensitive), up to limit, with their metadata.
// total counts every match.
func (s *Service) PrometheusMetricNames(ctx context.Context, pattern string, limit int) ([]PromMetricInfo, int, error) {
	src := s.getPromSource(ctx)
	if src == nil {
		return nil, 0, nil
	}
	match, err := src.matchParam("")
	if err != nil {
		return nil, 0, err
	}
	data, err := s.promGetData(ctx, src, "/api/v1/label/__name__/values?"+windowParams(match, 0, 0).Encode())
	if err != nil {
		return nil, 0, err
	}
	var names []string
	if err := json.Unmarshal(data, &names); err != nil {
		return nil, 0, fmt.Errorf("%w: metric names: %v", ErrPrometheusUpstream, err)
	}
	p := strings.ToLower(strings.TrimSpace(pattern))
	picked := names[:0]
	for _, n := range names {
		if p == "" || strings.Contains(strings.ToLower(n), p) {
			picked = append(picked, n)
		}
	}
	sort.Strings(picked)
	total := len(picked)
	if limit > 0 && len(picked) > limit {
		picked = picked[:limit]
	}
	// Metadata is optional (a remote-written store may have none): names alone then.
	meta := map[string][]struct{ Type, Help, Unit string }{}
	if raw, err := s.promGetData(ctx, src, "/api/v1/metadata?limit_per_metric=1"); err == nil {
		_ = json.Unmarshal(raw, &meta)
	}
	out := make([]PromMetricInfo, 0, len(picked))
	for _, n := range picked {
		info := PromMetricInfo{Name: n}
		if m := meta[n]; len(m) > 0 {
			info.Type, info.Help, info.Unit = m[0].Type, m[0].Help, m[0].Unit
		}
		out = append(out, info)
	}
	return out, total, nil
}

// PrometheusLabels lists label names (label == "") or the values of one label
// on the series selector matches within since, at most limit+1 (so the caller
// can tell it was cut).
func (s *Service) PrometheusLabels(ctx context.Context, label, selector string, since time.Duration, limit int) ([]string, error) {
	src := s.getPromSource(ctx)
	if src == nil {
		return nil, nil
	}
	match, err := src.matchParam(selector)
	if err != nil {
		return nil, err
	}
	path := "/api/v1/labels"
	if label != "" {
		path = "/api/v1/label/" + url.PathEscape(label) + "/values"
	}
	data, err := s.promGetData(ctx, src, path+"?"+windowParams(match, since, limit+1).Encode())
	if err != nil {
		return nil, err
	}
	var vals []string
	if err := json.Unmarshal(data, &vals); err != nil {
		return nil, fmt.Errorf("%w: labels: %v", ErrPrometheusUpstream, err)
	}
	sort.Strings(vals)
	return vals, nil
}

// PromRuleAlert is one active alert of an alerting rule.
type PromRuleAlert struct {
	Labels   map[string]string `json:"labels"`
	State    string            `json:"state"`
	ActiveAt string            `json:"active_at,omitempty"`
	Value    string            `json:"value,omitempty"`
}

// PromRule is one alerting or recording rule, flattened out of its group.
type PromRule struct {
	Group       string            `json:"group"`
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	Query       string            `json:"query"`
	ForSeconds  float64           `json:"for_seconds,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	State       string            `json:"state,omitempty"`
	Health      string            `json:"health,omitempty"`
	LastError   string            `json:"last_error,omitempty"`
	Alerts      []PromRuleAlert   `json:"alerts,omitempty"`
}

// PrometheusRules lists the store's rules (ruleType "alert"/"record"/""),
// those whose name contains name. On a shared store the active alerts are only
// this cluster's and a rule's state is worked out from them; shared tells the
// caller the definitions may cover every cluster.
func (s *Service) PrometheusRules(ctx context.Context, ruleType, name string) ([]PromRule, bool, error) {
	src := s.getPromSource(ctx)
	if src == nil {
		return nil, false, nil
	}
	q := url.Values{}
	if ruleType == "alert" || ruleType == "record" {
		q.Set("type", ruleType)
	}
	data, err := s.promGetData(ctx, src, "/api/v1/rules?"+q.Encode())
	if err != nil {
		return nil, false, err
	}
	var reply struct {
		Groups []struct {
			Name  string `json:"name"`
			Rules []struct {
				Name        string            `json:"name"`
				Type        string            `json:"type"`
				Query       string            `json:"query"`
				Duration    float64           `json:"duration"`
				Labels      map[string]string `json:"labels"`
				Annotations map[string]string `json:"annotations"`
				State       string            `json:"state"`
				Health      string            `json:"health"`
				LastError   string            `json:"lastError"`
				Alerts      []struct {
					Labels   map[string]string `json:"labels"`
					State    string            `json:"state"`
					ActiveAt string            `json:"activeAt"`
					Value    string            `json:"value"`
				} `json:"alerts"`
			} `json:"rules"`
		} `json:"groups"`
	}
	if err := json.Unmarshal(data, &reply); err != nil {
		return nil, false, fmt.Errorf("%w: rules: %v", ErrPrometheusUpstream, err)
	}
	shared := src.ext != nil && src.ext.labelValue != ""
	labelName := PrometheusClusterLabelName()
	n := strings.ToLower(strings.TrimSpace(name))
	var out []PromRule
	for _, g := range reply.Groups {
		for _, r := range g.Rules {
			if n != "" && !strings.Contains(strings.ToLower(r.Name), n) {
				continue
			}
			rule := PromRule{Group: g.Name, Name: r.Name, Type: r.Type, Query: r.Query, ForSeconds: r.Duration,
				Labels: r.Labels, Annotations: r.Annotations, State: r.State, Health: r.Health, LastError: r.LastError}
			if rule.Type == "alerting" {
				firing, pending := false, false
				for _, a := range r.Alerts {
					if shared && a.Labels[labelName] != src.ext.labelValue {
						continue
					}
					rule.Alerts = append(rule.Alerts, PromRuleAlert{Labels: a.Labels, State: a.State, ActiveAt: a.ActiveAt, Value: a.Value})
					firing = firing || a.State == "firing"
					pending = pending || a.State == "pending"
				}
				if shared {
					switch {
					case firing:
						rule.State = "firing"
					case pending:
						rule.State = "pending"
					default:
						rule.State = "inactive"
					}
				}
			}
			out = append(out, rule)
		}
	}
	return out, shared, nil
}

// PromTarget is one scrape target, from the targets API or from `up`.
type PromTarget struct {
	Job        string `json:"job"`
	Instance   string `json:"instance"`
	Health     string `json:"health"`
	LastError  string `json:"last_error,omitempty"`
	LastScrape string `json:"last_scrape,omitempty"`
	ScrapePool string `json:"scrape_pool,omitempty"`
}

// PrometheusTargets reports the scrape targets: the targets API of a
// Prometheus that belongs to this cluster, or the `up` series (this cluster's
// only, on a shared store, and wherever the targets API is not served).
func (s *Service) PrometheusTargets(ctx context.Context) ([]PromTarget, string, error) {
	src := s.getPromSource(ctx)
	if src == nil {
		return nil, "", nil
	}
	if src.ext == nil || src.ext.labelValue == "" {
		data, err := s.promGetData(ctx, src, "/api/v1/targets?state=active")
		if err == nil {
			var reply struct {
				ActiveTargets []struct {
					Labels     map[string]string `json:"labels"`
					ScrapePool string            `json:"scrapePool"`
					Health     string            `json:"health"`
					LastError  string            `json:"lastError"`
					LastScrape string            `json:"lastScrape"`
				} `json:"activeTargets"`
			}
			if err := json.Unmarshal(data, &reply); err != nil {
				return nil, "", fmt.Errorf("%w: targets: %v", ErrPrometheusUpstream, err)
			}
			out := make([]PromTarget, 0, len(reply.ActiveTargets))
			for _, t := range reply.ActiveTargets {
				out = append(out, PromTarget{Job: t.Labels["job"], Instance: t.Labels["instance"], Health: t.Health,
					LastError: t.LastError, LastScrape: t.LastScrape, ScrapePool: t.ScrapePool})
			}
			return out, "targets_api", nil
		}
		if !errors.Is(err, ErrPrometheusNotServed) {
			return nil, "", err
		}
	}
	query, err := src.scoped("up")
	if err != nil {
		return nil, "", err
	}
	raw, err := s.promFetch(ctx, src, "/api/v1/query?query="+url.QueryEscape(query))
	if err != nil {
		return nil, "", err
	}
	out := make([]PromTarget, 0, len(raw))
	for _, r := range raw {
		metric, _ := r["metric"].(map[string]interface{})
		job, _ := metric["job"].(string)
		instance, _ := metric["instance"].(string)
		health := "down"
		if extractPrometheusValue(r) == 1 {
			health = "up"
		}
		out = append(out, PromTarget{Job: job, Instance: instance, Health: health})
	}
	return out, "up_metric", nil
}
