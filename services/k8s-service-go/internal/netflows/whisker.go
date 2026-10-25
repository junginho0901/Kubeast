package netflows

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// whiskerFlow is one item of the Whisker backend's GET /flows (Calico v3.33.0
// whisker-backend/pkg/apis/v1/flows.go FlowResponse): the flows Goldmane
// aggregated over the window for one key — ends, port, protocol, action and the
// node side that reported them.
type whiskerFlow struct {
	StartTime       time.Time `json:"start_time"`
	EndTime         time.Time `json:"end_time"`
	Action          string    `json:"action"`
	SourceName      string    `json:"source_name"`
	SourceNamespace string    `json:"source_namespace"`
	DestName        string    `json:"dest_name"`
	DestNamespace   string    `json:"dest_namespace"`
	Protocol        string    `json:"protocol"`
	DestPort        int64     `json:"dest_port"`
	Reporter        string    `json:"reporter"`
	Policies        struct {
		Enforced []whiskerPolicyHit `json:"enforced"`
	} `json:"policies"`
	PacketsIn  int64 `json:"packets_in"`
	PacketsOut int64 `json:"packets_out"`
}

type whiskerPolicyHit struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Action    string `json:"action"`
}

// MaxWhiskerBytes caps one Whisker answer: the backend lists every flow of the
// window (it takes page and pageSize but does not pass them on to Goldmane).
const MaxWhiskerBytes = 16 << 20

// whiskerActions are the Calico actions of the verdicts asked for.
var whiskerActions = map[string]string{"FORWARDED": "Allow", "DROPPED": "Deny"}

// queryWhisker reads the request's flows from Calico's Whisker backend at url:
// one list with either end in the namespaces (Whisker's filter fields combine
// with AND, so that is two lists), each item turned into a flow.
func (s *Store) queryWhisker(ctx context.Context, client *http.Client, base string, req Request, now time.Time) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Timeout)
	defer cancel()
	var actions []string
	for _, v := range req.Verdicts {
		if a, ok := whiskerActions[v]; ok {
			actions = append(actions, a)
		}
	}
	if len(req.Verdicts) > 0 && len(actions) == 0 { // no Calico action for those verdicts
		return s.keep(ctx, req, nil, now, false), nil
	}
	seen := map[string]bool{}
	var flows []Flow
	for _, side := range []string{"source_namespaces", "dest_namespaces"} {
		items, err := whiskerList(ctx, client, base, whiskerQuery(req, side, actions))
		if err != nil {
			return nil, err
		}
		for _, it := range items {
			// an item with both ends in the namespaces is in both lists
			k := fmt.Sprintf("%v|%s|%s/%s|%s/%s|%d|%s|%s", it.StartTime.Unix(), it.Action, it.SourceNamespace, it.SourceName, it.DestNamespace, it.DestName, it.DestPort, it.Protocol, it.Reporter)
			if !seen[k] {
				seen[k] = true
				flows = append(flows, it.flow())
			}
		}
	}
	sort.SliceStable(flows, func(i, j int) bool { return flows[i].Time.After(flows[j].Time) })
	return s.keep(ctx, req, flows, now, len(flows) > req.Limit), nil
}

func whiskerQuery(req Request, side string, actions []string) url.Values {
	var names []map[string]string
	for _, ns := range req.Namespaces() {
		names = append(names, map[string]string{"value": ns, "type": "Exact"})
	}
	filters := map[string]any{side: names}
	if len(actions) > 0 {
		filters["actions"] = actions
	}
	f, _ := json.Marshal(filters)
	return url.Values{"startTimeGte": {strconv.Itoa(-int(req.Since.Seconds()))}, "filters": {string(f)}}
}

func whiskerList(ctx context.Context, client *http.Client, base string, q url.Values) ([]whiskerFlow, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Accept", "application/json")
	resp, err := client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, whiskerStatusError(resp)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxWhiskerBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if len(body) > MaxWhiskerBytes {
		return nil, fmt.Errorf("%w: Whisker answered more than %d MiB; ask for a shorter window", ErrUnavailable, MaxWhiskerBytes>>20)
	}
	var list struct {
		Items []whiskerFlow `json:"items"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, fmt.Errorf("%w: the answer is not Whisker's flow list: %v", ErrUnavailable, err)
	}
	return list.Items, nil
}

func whiskerStatusError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	detail := strings.TrimSpace(string(body))
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: the cluster refused the Whisker read (%d): %s", ErrForbidden, resp.StatusCode, detail)
	case http.StatusNotFound:
		return fmt.Errorf("%w: no Whisker Service there (404 — is Whisker on in the Tigera operator?): %s", ErrRelayMissing, detail)
	case http.StatusServiceUnavailable, http.StatusBadGateway:
		return fmt.Errorf("%w (%d): %s — Whisker's own policy admits nothing: the cluster needs a policy that lets the API server reach Whisker", ErrUnavailable, resp.StatusCode, detail)
	}
	return fmt.Errorf("%w: Whisker answered %d: %s", ErrUnavailable, resp.StatusCode, detail)
}

// flow is the item as a flow. Calico names a set of pods by their GenerateName
// and "*" (looked up like a pod), an address outside the pods "PUBLIC NETWORK"
// or "PRIVATE NETWORK" with no namespace. One item stands for its packets: those
// the source sent (Count) and those back (ReplyCount), from the reporting side.
func (w whiskerFlow) flow() Flow {
	f := Flow{Time: w.EndTime, Protocol: strings.ToUpper(w.Protocol), Source: whiskerEnd(w.SourceNamespace, w.SourceName), Destination: whiskerEnd(w.DestNamespace, w.DestName)}
	f.Destination.Port = uint32(w.DestPort)
	f.Verdict = "FORWARDED"
	if w.Action == "Deny" {
		f.Verdict, f.DropReason = "DROPPED", "POLICY_DENIED"
	}
	sent, back := w.PacketsOut, w.PacketsIn
	f.Direction = "egress"
	if w.Reporter == "Dst" {
		f.Direction, sent, back = "ingress", w.PacketsIn, w.PacketsOut
	}
	f.Count, f.ReplyCount = int(max(sent, 1)), int(back)
	var p Policies
	for _, h := range w.Policies.Enforced {
		if h.Name == "" || h.Kind == "Profile" || h.Kind == "EndOfTier" || (h.Action != "Allow" && h.Action != "Deny") {
			continue
		}
		ref := PolicyRef{Kind: h.Kind, Namespace: h.Namespace, Name: h.Name}
		switch {
		case h.Action == "Allow" && f.Direction == "ingress":
			p.IngressAllowedBy = append(p.IngressAllowedBy, ref)
		case h.Action == "Allow":
			p.EgressAllowedBy = append(p.EgressAllowedBy, ref)
		case f.Direction == "ingress":
			p.IngressDeniedBy = append(p.IngressDeniedBy, ref)
		default:
			p.EgressDeniedBy = append(p.EgressDeniedBy, ref)
		}
	}
	if len(p.IngressAllowedBy)+len(p.EgressAllowedBy)+len(p.IngressDeniedBy)+len(p.EgressDeniedBy) > 0 {
		f.Policies = &p
	}
	return f
}

func whiskerEnd(namespace, name string) End {
	if namespace == "" || namespace == "-" {
		return End{Names: []string{strings.ToLower(name)}}
	}
	return End{Namespace: namespace, Pod: name}
}
