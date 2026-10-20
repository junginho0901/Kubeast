// Package alerts reads an alert store — Alertmanager's API v2, directly, through
// a Grafana data source proxy, or Grafana alerting's Alertmanager-compatible API —
// for one cluster's alerts and the silences on them. The store is asked with the
// cluster label as a matcher and every alert that comes back is checked again;
// silences are only those that silence one of the cluster's alerts.
package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/time/rate"

	pkgconfig "github.com/junginho0901/kubeast/services/pkg/config"
)

// Errors a read can end with.
var (
	ErrNotConfigured  = errors.New("alert store is not configured for this cluster")
	ErrInvalidRequest = errors.New("invalid request")
	ErrTimeout        = errors.New("alert store did not answer in time")
	ErrNotServed      = errors.New("not served by this alert store")
)

// StoreError is a non-200 answer from the store.
type StoreError struct {
	Status int
	Body   string
}

func (e *StoreError) Error() string {
	return fmt.Sprintf("alert store answered %d: %s", e.Status, e.Body)
}

// Config is the alert store configuration (chart features.alertStore).
type Config struct {
	Enabled    bool
	URL        string
	AuthHeader string
	Tenant     string
	// ClusterLabel is the label the store's alerts carry the cluster in.
	ClusterLabel string
	// Clusters maps a Kubeast cluster ID to the value of ClusterLabel. An
	// empty value (one cluster only) reads every alert of the store.
	Clusters         map[string]string
	MaxAlerts        int
	Timeout          time.Duration
	PerUserPerMinute int
	// SilencesEnabled lets resource.alert.silence holders make and expire
	// silences; the credentials then need write access to the store.
	SilencesEnabled    bool
	SilenceMaxDuration time.Duration
}

// LoadConfig reads the ALERT_STORE_* environment.
func LoadConfig() Config {
	timeout := 10 * time.Second
	if v := strings.TrimSpace(os.Getenv("ALERT_STORE_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			timeout = d
		} else {
			timeout = -1 // rejected by Validate
		}
	}
	return Config{
		Enabled:            pkgconfig.GetEnvBool("ALERT_STORE_ENABLED", false),
		URL:                strings.TrimRight(strings.TrimSpace(os.Getenv("ALERT_STORE_URL")), "/"),
		AuthHeader:         os.Getenv("ALERT_STORE_AUTH_HEADER"),
		Tenant:             strings.TrimSpace(os.Getenv("ALERT_STORE_TENANT")),
		ClusterLabel:       pkgconfig.GetEnv("ALERT_STORE_CLUSTER_LABEL", "cluster"),
		Clusters:           parseClusters(os.Getenv("ALERT_STORE_CLUSTERS")),
		MaxAlerts:          pkgconfig.GetEnvInt("ALERT_STORE_MAX_ALERTS", 100),
		Timeout:            timeout,
		PerUserPerMinute:   pkgconfig.GetEnvInt("ALERT_STORE_PER_USER_PER_MINUTE", 30),
		SilencesEnabled:    pkgconfig.GetEnvBool("ALERT_STORE_SILENCES_ENABLED", false),
		SilenceMaxDuration: time.Duration(pkgconfig.GetEnvInt("ALERT_STORE_SILENCE_MAX_HOURS", 168)) * time.Hour,
	}
}

// parseClusters reads "id=value,id2=value2" ("id=" for a store of one cluster).
func parseClusters(raw string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		id, value, _ := strings.Cut(part, "=")
		out[strings.TrimSpace(id)] = strings.TrimSpace(value)
	}
	return out
}

var labelName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// Validate rejects a configuration that could not read, or could read beyond
// one cluster's alerts. Only called when Enabled.
func (c Config) Validate() error {
	if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
		return fmt.Errorf("ALERT_STORE_URL must be an http(s) URL")
	}
	if !labelName.MatchString(c.ClusterLabel) {
		return fmt.Errorf("alert store cluster label %q is not a label name", c.ClusterLabel)
	}
	if len(c.Clusters) == 0 {
		return fmt.Errorf("ALERT_STORE_CLUSTERS lists no cluster (Kubeast cluster ID → value of the cluster label)")
	}
	for id, v := range c.Clusters {
		if id == "" {
			return fmt.Errorf("ALERT_STORE_CLUSTERS: an entry has no cluster ID")
		}
		if v == "" && len(c.Clusters) > 1 {
			return fmt.Errorf("ALERT_STORE_CLUSTERS: %q has no label value; an empty value (every alert of the store) is for a store of one cluster only", id)
		}
	}
	if c.MaxAlerts < 1 || c.MaxAlerts > 500 {
		return fmt.Errorf("ALERT_STORE_MAX_ALERTS must be 1..500")
	}
	if c.Timeout <= 0 {
		return fmt.Errorf("ALERT_STORE_TIMEOUT must be a positive duration")
	}
	if c.PerUserPerMinute < 1 {
		return fmt.Errorf("ALERT_STORE_PER_USER_PER_MINUTE must be at least 1")
	}
	if c.SilencesEnabled && (c.SilenceMaxDuration < time.Hour || c.SilenceMaxDuration > 90*24*time.Hour) {
		return fmt.Errorf("ALERT_STORE_SILENCE_MAX_HOURS must be 1..2160")
	}
	return nil
}

// ClusterIDs lists the configured clusters, sorted.
func (c Config) ClusterIDs() []string {
	ids := make([]string, 0, len(c.Clusters))
	for id := range c.Clusters {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Store reads the configured clusters' alerts and keeps the per-user rate
// limit (per k8s-service replica).
type Store struct {
	cfg  Config
	http *http.Client

	mu    sync.Mutex
	users map[string]*rate.Limiter
}

// New validates cfg and returns a store.
func New(cfg Config) (*Store, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Store{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout}, users: map[string]*rate.Limiter{}}, nil
}

// Config returns the configuration the store was built with.
func (s *Store) Config() Config { return s.cfg }

// Configured reports whether cluster id has alert reads.
func (s *Store) Configured(_ context.Context, id string) bool {
	if s == nil {
		return false
	}
	_, ok := s.cfg.Clusters[id]
	return ok
}

// Allow takes one read from user's budget.
func (s *Store) Allow(user string) bool {
	s.mu.Lock()
	lim, ok := s.users[user]
	if !ok {
		n := s.cfg.PerUserPerMinute
		lim = rate.NewLimiter(rate.Every(time.Minute/time.Duration(n)), n)
		s.users[user] = lim
	}
	s.mu.Unlock()
	return lim.Allow()
}

// States an alert is reported in.
const (
	StateFiring      = "firing"
	StateSilenced    = "silenced"
	StateInhibited   = "inhibited"
	StateUnprocessed = "unprocessed"
)

// Query is what the caller asks: a state ("" or "all" = every state), an
// alert name and label values, all exact.
type Query struct {
	State     string
	AlertName string
	Labels    map[string]string
}

// Check refuses what the store is not asked.
func (q Query) Check() error {
	switch q.State {
	case "", "all", StateFiring, StateSilenced, StateInhibited:
	default:
		return fmt.Errorf("%w: state is one of firing, silenced, inhibited, all", ErrInvalidRequest)
	}
	if len(q.Labels) > 10 {
		return fmt.Errorf("%w: at most 10 label values", ErrInvalidRequest)
	}
	for k, v := range q.Labels {
		if !labelName.MatchString(k) {
			return fmt.Errorf("%w: %q is not a label name", ErrInvalidRequest, k)
		}
		if !utf8.ValidString(v) || len(v) > 200 || strings.ContainsAny(v, "\x00\n\r") {
			return fmt.Errorf("%w: label %s: a value of at most 200 characters on one line", ErrInvalidRequest, k)
		}
	}
	if len(q.AlertName) > 200 || strings.ContainsAny(q.AlertName, "\x00\n\r") {
		return fmt.Errorf("%w: alertname: at most 200 characters on one line", ErrInvalidRequest)
	}
	return nil
}

// Alert is one alert as the caller gets it.
type Alert struct {
	Fingerprint string            `json:"fingerprint"`
	Name        string            `json:"alertname"`
	Severity    string            `json:"severity,omitempty"`
	State       string            `json:"state"`
	StartsAt    time.Time         `json:"startsAt"`
	Summary     string            `json:"summary,omitempty"`
	Description string            `json:"description,omitempty"`
	Labels      map[string]string `json:"labels"`
	Receivers   []string          `json:"receivers,omitempty"`
	SilencedBy  []string          `json:"silencedBy,omitempty"`
	InhibitedBy []string          `json:"inhibitedBy,omitempty"`
}

// Silence is a silence on one of the cluster's alerts.
type Silence struct {
	ID        string    `json:"id"`
	State     string    `json:"state"`
	Matchers  []string  `json:"matchers"`
	CreatedBy string    `json:"createdBy,omitempty"`
	Comment   string    `json:"comment,omitempty"`
	StartsAt  time.Time `json:"startsAt"`
	EndsAt    time.Time `json:"endsAt"`
}

// NameCount is how many alerts of one name and severity there are.
type NameCount struct {
	Name     string `json:"alertname"`
	Severity string `json:"severity,omitempty"`
	Count    int    `json:"count"`
}

// Result is one read.
type Result struct {
	Alerts    []Alert        `json:"alerts"`
	Total     int            `json:"total"`
	States    map[string]int `json:"states"`
	ByName    []NameCount    `json:"byName"`
	Silences  []Silence      `json:"silences"`
	Truncated bool           `json:"truncated"`
	// Filter is the matchers the store was asked with.
	Filter []string `json:"filter"`
}

// gettable* are the fields of Alertmanager's API v2 answers read here.
type gettableAlert struct {
	Fingerprint string            `json:"fingerprint"`
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	StartsAt    time.Time         `json:"startsAt"`
	Receivers   []struct {
		Name string `json:"name"`
	} `json:"receivers"`
	Status struct {
		State       string   `json:"state"`
		SilencedBy  []string `json:"silencedBy"`
		InhibitedBy []string `json:"inhibitedBy"`
	} `json:"status"`
}

type gettableSilence struct {
	ID       string `json:"id"`
	Matchers []struct {
		Name    string `json:"name"`
		Value   string `json:"value"`
		IsRegex bool   `json:"isRegex"`
		IsEqual *bool  `json:"isEqual"`
	} `json:"matchers"`
	CreatedBy string    `json:"createdBy"`
	Comment   string    `json:"comment"`
	StartsAt  time.Time `json:"startsAt"`
	EndsAt    time.Time `json:"endsAt"`
	Status    struct {
		State string `json:"state"`
	} `json:"status"`
}

// matcher writes name="value" with the value quoted as Alertmanager's matcher
// parsers read it.
func matcher(name, value string) string {
	return name + `="` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

func cut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

var severityRank = map[string]int{"critical": 0, "page": 0, "high": 1, "error": 1, "warning": 2, "medium": 2, "info": 3, "low": 3}

func rank(severity string) int {
	if r, ok := severityRank[strings.ToLower(severity)]; ok {
		return r
	}
	return 4
}

func stateOf(a gettableAlert) string {
	switch {
	case a.Status.State == "active":
		return StateFiring
	case len(a.Status.SilencedBy) > 0:
		return StateSilenced
	case len(a.Status.InhibitedBy) > 0:
		return StateInhibited
	case a.Status.State == "suppressed":
		return StateSilenced
	}
	return StateUnprocessed
}

// List reads cluster id's alerts in q's state with their silences.
func (s *Store) List(ctx context.Context, id string, q Query) (Result, error) {
	value, ok := s.cfg.Clusters[id]
	if !ok {
		return Result{}, ErrNotConfigured
	}
	if err := q.Check(); err != nil {
		return Result{}, err
	}
	want := map[string]string{}
	for k, v := range q.Labels {
		want[k] = v
	}
	if q.AlertName != "" {
		want["alertname"] = q.AlertName
	}
	if value != "" {
		want[s.cfg.ClusterLabel] = value // after the caller's: the cluster's value wins
	}
	filter := make([]string, 0, len(want))
	for k, v := range want {
		filter = append(filter, matcher(k, v))
	}
	sort.Strings(filter)
	res := Result{Alerts: []Alert{}, States: map[string]int{}, ByName: []NameCount{}, Silences: []Silence{}, Filter: filter}

	body, err := s.get(ctx, "/api/v2/alerts", url.Values{"filter": filter})
	if err != nil {
		return res, err
	}
	var got []gettableAlert
	if err := json.Unmarshal(body, &got); err != nil {
		return res, fmt.Errorf("alert store: unreadable answer: %w", err)
	}
	counts := map[[2]string]int{}
	silenceIDs := map[string]bool{}
	var kept []Alert
	for _, a := range got {
		match := true
		for k, v := range want { // the store's matching is not trusted: the labels are checked here
			if a.Labels[k] != v {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		state := stateOf(a)
		res.States[state]++
		if q.State != "" && q.State != "all" && q.State != state {
			continue
		}
		name, severity := a.Labels["alertname"], a.Labels["severity"]
		counts[[2]string{name, severity}]++
		labels := map[string]string{}
		for k, v := range a.Labels {
			if !strings.HasPrefix(k, "__") && k != "alertname" && k != "severity" && len(labels) < 20 {
				labels[k] = cut(v, 200)
			}
		}
		al := Alert{Fingerprint: a.Fingerprint, Name: name, Severity: severity, State: state, StartsAt: a.StartsAt,
			Summary: cut(a.Annotations["summary"], 300), Description: cut(a.Annotations["description"], 300), Labels: labels,
			SilencedBy: a.Status.SilencedBy, InhibitedBy: a.Status.InhibitedBy}
		for _, r := range a.Receivers {
			al.Receivers = append(al.Receivers, r.Name)
		}
		for _, sid := range a.Status.SilencedBy {
			silenceIDs[sid] = true
		}
		kept = append(kept, al)
	}
	sort.SliceStable(kept, func(i, j int) bool {
		a, b := kept[i], kept[j]
		if (a.State == StateFiring) != (b.State == StateFiring) {
			return a.State == StateFiring
		}
		if rank(a.Severity) != rank(b.Severity) {
			return rank(a.Severity) < rank(b.Severity)
		}
		return a.StartsAt.After(b.StartsAt)
	})
	res.Total = len(kept)
	if len(kept) > s.cfg.MaxAlerts {
		kept, res.Truncated = kept[:s.cfg.MaxAlerts], true
	}
	res.Alerts = append(res.Alerts, kept...)
	for k, n := range counts {
		res.ByName = append(res.ByName, NameCount{Name: k[0], Severity: k[1], Count: n})
	}
	sort.Slice(res.ByName, func(i, j int) bool {
		if res.ByName[i].Count != res.ByName[j].Count {
			return res.ByName[i].Count > res.ByName[j].Count
		}
		return res.ByName[i].Name < res.ByName[j].Name
	})
	if len(res.ByName) > 30 {
		res.ByName = res.ByName[:30]
	}
	if len(silenceIDs) == 0 {
		return res, nil
	}
	body, err = s.get(ctx, "/api/v2/silences", nil)
	if err != nil {
		return res, err
	}
	var silences []gettableSilence
	if err := json.Unmarshal(body, &silences); err != nil {
		return res, fmt.Errorf("alert store: unreadable silences: %w", err)
	}
	for _, sl := range silences {
		if !silenceIDs[sl.ID] {
			continue // not on one of this cluster's alerts
		}
		out := Silence{ID: sl.ID, State: sl.Status.State, CreatedBy: cut(sl.CreatedBy, 100), Comment: cut(sl.Comment, 300), StartsAt: sl.StartsAt, EndsAt: sl.EndsAt, Matchers: []string{}}
		for _, m := range sl.Matchers {
			op := "="
			equal := m.IsEqual == nil || *m.IsEqual
			switch {
			case m.IsRegex && equal:
				op = "=~"
			case m.IsRegex:
				op = "!~"
			case !equal:
				op = "!="
			}
			out.Matchers = append(out.Matchers, m.Name+op+`"`+cut(m.Value, 200)+`"`)
		}
		res.Silences = append(res.Silences, out)
	}
	sort.Slice(res.Silences, func(i, j int) bool { return res.Silences[i].EndsAt.Before(res.Silences[j].EndsAt) })
	return res, nil
}

const maxBody = 16 << 20

// get asks the store for path and returns a 2xx answer's body.
func (s *Store) get(ctx context.Context, path string, params url.Values) ([]byte, error) {
	target := s.cfg.URL + path
	if len(params) > 0 {
		target += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	return s.do(req)
}

// do sends req with the store's credentials and returns a 2xx answer's body.
func (s *Store) do(req *http.Request) ([]byte, error) {
	req.Header.Set("Accept", "application/json")
	if s.cfg.AuthHeader != "" {
		req.Header.Set("Authorization", s.cfg.AuthHeader)
	}
	if s.cfg.Tenant != "" {
		req.Header.Set("X-Scope-OrgID", s.cfg.Tenant)
	}
	resp, err := s.http.Do(req)
	if err != nil {
		var te interface{ Timeout() bool }
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &te) && te.Timeout()) {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("alert store: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return nil, fmt.Errorf("alert store: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotServed
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &StoreError{Status: resp.StatusCode, Body: cut(strings.TrimSpace(string(body)), 300)}
	}
	return body, nil
}
