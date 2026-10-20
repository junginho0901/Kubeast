package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Silence writes (chart features.alertStore.silences): a silence is made, listed and expired for one cluster only.
// The cluster label matcher is added to every silence here, so a silence made for one cluster mutes nothing of
// another; a silence that does not carry it is not that cluster's to expire.

// ErrSilencesOff is a write with features.alertStore.silences off.
var ErrSilencesOff = errors.New("silences are off for the alert store (features.alertStore.silences)")

// ErrNotFound is a silence the cluster does not have.
var ErrNotFound = errors.New("no such silence on this cluster")

// Matcher is one label condition of a silence, as Alertmanager's API v2 takes it.
type Matcher struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	IsRegex bool   `json:"isRegex"`
	IsEqual bool   `json:"isEqual"`
}

func (m Matcher) String() string {
	op := "="
	switch {
	case m.IsRegex && m.IsEqual:
		op = "=~"
	case m.IsRegex:
		op = "!~"
	case !m.IsEqual:
		op = "!="
	}
	return m.Name + op + `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(m.Value) + `"`
}

// matches reports whether value satisfies m (Alertmanager anchors a regex at both ends).
func (m Matcher) matches(value string) bool {
	var ok bool
	if m.IsRegex {
		re, err := regexp.Compile("^(?:" + m.Value + ")$")
		ok = err == nil && re.MatchString(value)
	} else {
		ok = value == m.Value
	}
	return ok == m.IsEqual
}

// SilenceRequest is what a user asks for: label conditions, how long, why.
type SilenceRequest struct {
	Matchers []Matcher     `json:"matchers"`
	Duration time.Duration `json:"-"`
	Comment  string        `json:"comment"`
}

// CheckMatchers rejects conditions that are not this user's to set: none, too many, the cluster label (added
// here), a bad name, value or regex, or only conditions an empty label satisfies (they would mute nearly every
// alert of the cluster — Alertmanager asks for the same).
func (s *Store) CheckMatchers(ms []Matcher) error {
	if len(ms) == 0 || len(ms) > 10 {
		return fmt.Errorf("%w: 1 to 10 label conditions", ErrInvalidRequest)
	}
	narrow := false
	for _, m := range ms {
		if !labelName.MatchString(m.Name) {
			return fmt.Errorf("%w: %q is not a label name", ErrInvalidRequest, m.Name)
		}
		if m.Name == s.cfg.ClusterLabel {
			return fmt.Errorf("%w: the %s condition is added for the cluster; leave it out", ErrInvalidRequest, m.Name)
		}
		if !utf8.ValidString(m.Value) || len(m.Value) > 200 || strings.ContainsAny(m.Value, "\x00\n\r") {
			return fmt.Errorf("%w: %s: a value of at most 200 characters on one line", ErrInvalidRequest, m.Name)
		}
		if m.IsRegex {
			if _, err := regexp.Compile("^(?:" + m.Value + ")$"); err != nil {
				return fmt.Errorf("%w: %s: not a regular expression: %v", ErrInvalidRequest, m.Name, err)
			}
		}
		if !m.matches("") {
			narrow = true
		}
	}
	if !narrow {
		return fmt.Errorf("%w: at least one condition an empty label does not satisfy (for example alertname=\"…\")", ErrInvalidRequest)
	}
	return nil
}

// scoped is ms with the cluster label condition added (none for a store of one cluster).
func (s *Store) scoped(id string, ms []Matcher) ([]Matcher, error) {
	value, ok := s.cfg.Clusters[id]
	if !ok {
		return nil, ErrNotConfigured
	}
	out := append([]Matcher{}, ms...)
	if value != "" {
		out = append(out, Matcher{Name: s.cfg.ClusterLabel, Value: value, IsEqual: true})
	}
	return out, nil
}

// ours reports whether a silence carries cluster id's label condition exactly (every silence, for a store of one cluster).
func (s *Store) ours(id string, sl gettableSilence) bool {
	value := s.cfg.Clusters[id]
	if value == "" {
		return true
	}
	for _, m := range sl.Matchers {
		if m.Name == s.cfg.ClusterLabel && m.Value == value && !m.IsRegex && (m.IsEqual == nil || *m.IsEqual) {
			return true
		}
	}
	return false
}

func silenceOf(sl gettableSilence) Silence {
	out := Silence{ID: sl.ID, State: sl.Status.State, CreatedBy: cut(sl.CreatedBy, 100), Comment: cut(sl.Comment, 300), StartsAt: sl.StartsAt, EndsAt: sl.EndsAt, Matchers: []string{}}
	for _, m := range sl.Matchers {
		out.Matchers = append(out.Matchers, Matcher{Name: m.Name, Value: cut(m.Value, 200), IsRegex: m.IsRegex, IsEqual: m.IsEqual == nil || *m.IsEqual}.String())
	}
	return out
}

// Silences lists cluster id's active and pending silences, the soonest to end first.
func (s *Store) Silences(ctx context.Context, id string) ([]Silence, error) {
	if _, ok := s.cfg.Clusters[id]; !ok {
		return nil, ErrNotConfigured
	}
	body, err := s.get(ctx, "/api/v2/silences", nil)
	if err != nil {
		return nil, err
	}
	var all []gettableSilence
	if err := json.Unmarshal(body, &all); err != nil {
		return nil, fmt.Errorf("alert store: unreadable silences: %w", err)
	}
	out := []Silence{}
	for _, sl := range all {
		if (sl.Status.State == "active" || sl.Status.State == "pending") && s.ours(id, sl) {
			out = append(out, silenceOf(sl))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EndsAt.Before(out[j].EndsAt) })
	return out, nil
}

// Preview lists the cluster's alerts a silence with these conditions would mute now (at most MaxAlerts).
func (s *Store) Preview(ctx context.Context, id string, ms []Matcher) (Result, error) {
	if err := s.CheckMatchers(ms); err != nil {
		return Result{}, err
	}
	all, err := s.scoped(id, ms)
	if err != nil {
		return Result{}, err
	}
	params := url.Values{}
	for _, m := range all {
		params.Add("filter", m.String())
	}
	body, err := s.get(ctx, "/api/v2/alerts", params)
	if err != nil {
		return Result{}, err
	}
	var got []gettableAlert
	if err := json.Unmarshal(body, &got); err != nil {
		return Result{}, fmt.Errorf("alert store: unreadable alerts: %w", err)
	}
	res := Result{Alerts: []Alert{}, States: map[string]int{}, ByName: []NameCount{}, Silences: []Silence{}, Filter: params["filter"]}
	for _, a := range got {
		matched := true
		for _, m := range all { // the store's own filter, checked again here
			if !m.matches(a.Labels[m.Name]) {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		res.Total++
		state := stateOf(a)
		res.States[state]++
		if len(res.Alerts) < s.cfg.MaxAlerts {
			res.Alerts = append(res.Alerts, Alert{Fingerprint: a.Fingerprint, Name: a.Labels["alertname"], Severity: a.Labels["severity"], State: state,
				StartsAt: a.StartsAt, Summary: cut(a.Annotations["summary"], 300), Labels: a.Labels})
		} else {
			res.Truncated = true
		}
	}
	return res, nil
}

// Create makes the silence for cluster id and returns its ID.
func (s *Store) Create(ctx context.Context, id string, req SilenceRequest, createdBy string, now time.Time) (string, []Matcher, error) {
	if !s.cfg.SilencesEnabled {
		return "", nil, ErrSilencesOff
	}
	if err := s.CheckMatchers(req.Matchers); err != nil {
		return "", nil, err
	}
	if req.Duration < time.Minute || req.Duration > s.cfg.SilenceMaxDuration {
		return "", nil, fmt.Errorf("%w: a duration from 1 minute to %s", ErrInvalidRequest, s.cfg.SilenceMaxDuration)
	}
	comment := strings.TrimSpace(req.Comment)
	if comment == "" || utf8.RuneCountInString(comment) > 500 {
		return "", nil, fmt.Errorf("%w: a comment of 1 to 500 characters (why it is silenced)", ErrInvalidRequest)
	}
	all, err := s.scoped(id, req.Matchers)
	if err != nil {
		return "", nil, err
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"matchers": all, "startsAt": now.UTC().Format(time.RFC3339), "endsAt": now.Add(req.Duration).UTC().Format(time.RFC3339),
		"createdBy": createdBy, "comment": comment,
	})
	body, err := s.send(ctx, http.MethodPost, "/api/v2/silences", payload)
	if err != nil {
		return "", all, err
	}
	var out struct {
		SilenceID string `json:"silenceID"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.SilenceID == "" {
		return "", all, fmt.Errorf("alert store: no silence ID in the answer")
	}
	return out.SilenceID, all, nil
}

var silenceID = regexp.MustCompile(`^[0-9A-Za-z-]{1,64}$`)

// Expire ends cluster id's silence silenceID now (Alertmanager keeps it as expired).
func (s *Store) Expire(ctx context.Context, id, sid string) (Silence, error) {
	if !s.cfg.SilencesEnabled {
		return Silence{}, ErrSilencesOff
	}
	if _, ok := s.cfg.Clusters[id]; !ok {
		return Silence{}, ErrNotConfigured
	}
	if !silenceID.MatchString(sid) {
		return Silence{}, fmt.Errorf("%w: not a silence ID", ErrInvalidRequest)
	}
	body, err := s.get(ctx, "/api/v2/silence/"+sid, nil)
	if errors.Is(err, ErrNotServed) {
		return Silence{}, ErrNotFound
	}
	if err != nil {
		return Silence{}, err
	}
	var sl gettableSilence
	if err := json.Unmarshal(body, &sl); err != nil {
		return Silence{}, fmt.Errorf("alert store: unreadable silence: %w", err)
	}
	if !s.ours(id, sl) {
		return Silence{}, ErrNotFound // another cluster's (or the whole store's): not this cluster's to end
	}
	if _, err := s.send(ctx, http.MethodDelete, "/api/v2/silence/"+sid, nil); err != nil {
		return Silence{}, err
	}
	return silenceOf(sl), nil
}

// send makes a write request to the store and returns a 2xx answer's body.
func (s *Store) send(ctx context.Context, method, path string, payload []byte) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, s.cfg.URL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return s.do(req)
}
