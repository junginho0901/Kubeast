package netflows

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

var (
	ErrInvalidRequest = errors.New("invalid flow request")
	ErrForbidden      = errors.New("forbidden")
	ErrRelayMissing   = errors.New("no flow source found")
	ErrUnavailable    = errors.New("flow source unavailable")
	ErrTimeout        = errors.New("flow source did not answer in time")
)

// Kinds a flow request can name, besides the whole namespace.
var Kinds = map[string]bool{"Pod": true, "Deployment": true, "StatefulSet": true, "DaemonSet": true, "ReplicaSet": true, "Job": true, "CronJob": true}

// Store reads flows for the configured clusters.
type Store struct {
	cfg     Config
	address *http.Client

	mu    sync.Mutex
	users map[string]*rate.Limiter
}

// New builds the store; the TLS files of mode address are read here.
func New(cfg Config) (*Store, error) {
	s := &Store{cfg: cfg, users: map[string]*rate.Limiter{}}
	for _, t := range cfg.Clusters {
		if t.Mode == "address" {
			client, err := addressClient(cfg)
			if err != nil {
				return nil, err
			}
			s.address = client
			break
		}
	}
	return s, nil
}

func addressClient(cfg Config) (*http.Client, error) {
	tc := &tls.Config{MinVersion: tls.VersionTLS12, ServerName: cfg.ServerName}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("network flows CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("network flows CA %s holds no PEM certificate", cfg.CAFile)
		}
		tc.RootCAs = pool
	}
	if cfg.CertFile != "" {
		cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("network flows client certificate: %w", err)
		}
		tc.Certificates = []tls.Certificate{cert}
	}
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig:   tc,
		ForceAttemptHTTP2: true,
		DialContext:       (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
	}}, nil
}

func (s *Store) Config() Config { return s.cfg }

// Configured reports whether a cluster has flow reads.
func (s *Store) Configured(_ context.Context, id string) bool {
	if s == nil {
		return false
	}
	_, ok := s.cfg.Clusters[id]
	return ok
}

// Target is how a cluster's Relay is reached.
func (s *Store) Target(id string) (Target, bool) {
	t, ok := s.cfg.Clusters[id]
	return t, ok
}

// AddressClient is the TLS client for mode address.
func (s *Store) AddressClient() *http.Client { return s.address }

// Allow takes one read from the user's per-minute budget.
func (s *Store) Allow(user string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	lim, ok := s.users[user]
	if !ok {
		n := s.cfg.PerUserPerMinute
		lim = rate.NewLimiter(rate.Every(time.Minute/time.Duration(n)), n)
		s.users[user] = lim
	}
	return lim.Allow()
}

// Request is what to read: the flows of a namespace, or of one pod or
// workload in it, each matching either side of a flow.
type Request struct {
	Namespace string
	Kind      string // "" for the whole namespace
	Name      string
	// More are the other namespaces of a Resource Graph read (Graph), read like Namespace.
	More     []string
	Graph    bool // a Resource Graph read: up to GraphMaxFlows
	Verdicts []string
	Since    time.Duration
	Limit    int
	// Scope is a namespace-scoped reader's namespaces (nil = the whole cluster):
	// peers outside it are shown by namespace and address only.
	Scope []string
	// Pods are a workload's current pods, asked for by name as well, for flows that name no workload.
	Pods []string
	// PodSet is the pod's set as Calico names it (<generateName>*): a Pod read on Calico reads its set's flows.
	PodSet string
	// Lookup fills in what the flows leave out (nil: nothing).
	Lookup Lookup
}

// MaxPods caps the pods of a workload read asked for by name.
const MaxPods = 100

// Normalize fills defaults and refuses what the configuration does not allow.
func (s *Store) Normalize(r *Request) error {
	if r.Namespace == "" {
		return fmt.Errorf("%w: a namespace is required", ErrInvalidRequest)
	}
	if r.Kind != "" && !Kinds[r.Kind] {
		return fmt.Errorf("%w: kind %q (Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob)", ErrInvalidRequest, r.Kind)
	}
	if (r.Kind == "") != (r.Name == "") {
		return fmt.Errorf("%w: kind and name go together", ErrInvalidRequest)
	}
	for i, v := range r.Verdicts {
		v = strings.ToUpper(strings.TrimSpace(v))
		if _, ok := Verdicts[v]; !ok {
			return fmt.Errorf("%w: verdict %q", ErrInvalidRequest, v)
		}
		r.Verdicts[i] = v
	}
	if r.Since == 0 {
		r.Since = s.cfg.DefaultRange
	}
	if r.Since < 0 || r.Since > s.cfg.MaxRange {
		return fmt.Errorf("%w: since must be between 1s and %s", ErrInvalidRequest, s.cfg.MaxRange)
	}
	if len(r.More) > 0 && (!r.Graph || r.Kind != "") {
		return fmt.Errorf("%w: more namespaces are for a whole-namespace graph read", ErrInvalidRequest)
	}
	if len(r.Pods) > 0 && (r.Kind == "" || r.Kind == "Pod") {
		return fmt.Errorf("%w: pods are for a workload read", ErrInvalidRequest)
	}
	if len(r.Pods) > MaxPods {
		r.Pods = r.Pods[:MaxPods]
	}
	max := s.cfg.MaxFlows
	if r.Graph {
		max = s.cfg.GraphMaxFlows
	}
	if r.Limit <= 0 || r.Limit > max {
		r.Limit = max
	}
	return nil
}

// Namespaces are the request's namespaces: Namespace, then More.
func (r Request) Namespaces() []string { return append([]string{r.Namespace}, r.More...) }

func (r Request) filters() []filter {
	var verdicts []int32
	for _, v := range r.Verdicts {
		verdicts = append(verdicts, Verdicts[v])
	}
	src, dst := filter{verdicts: verdicts}, filter{verdicts: verdicts}
	switch r.Kind {
	case "":
		for _, ns := range r.Namespaces() {
			src.sourcePod, dst.destinationPod = append(src.sourcePod, ns+"/"), append(dst.destinationPod, ns+"/")
		}
	case "Pod":
		// a prefix to Hubble: the exact name is checked on the answer
		src.sourcePod, dst.destinationPod = []string{r.Namespace + "/" + r.Name}, []string{r.Namespace + "/" + r.Name}
	default:
		w := []Workload{{Kind: r.Kind, Name: r.Name}}
		src.sourcePod, src.sourceWorkload = []string{r.Namespace + "/"}, w
		dst.destinationPod, dst.destinationWorkload = []string{r.Namespace + "/"}, w
		if len(r.Pods) > 0 {
			names := make([]string, len(r.Pods))
			for i, p := range r.Pods {
				names[i] = r.Namespace + "/" + p
			}
			return []filter{src, dst, {sourcePod: names, verdicts: verdicts}, {destinationPod: names, verdicts: verdicts}}
		}
	}
	return []filter{src, dst}
}

func (r Request) side(e End) bool {
	if r.Kind == "" {
		for _, ns := range r.Namespaces() {
			if e.Namespace == ns {
				return true
			}
		}
		return false
	}
	if e.Namespace != r.Namespace {
		return false
	}
	switch r.Kind {
	case "Pod":
		return e.Pod == r.Name || r.PodSet != "" && e.Pod == r.PodSet
	default:
		return e.Workload != nil && e.Workload.Kind == r.Kind && e.Workload.Name == r.Name
	}
}

// matches checks a flow again: Hubble's pod filter is a prefix, and what
// comes back is never trusted to be what was asked.
func (r Request) matches(f Flow) bool {
	if !r.side(f.Source) && !r.side(f.Destination) {
		return false
	}
	if len(r.Verdicts) == 0 {
		return true
	}
	for _, v := range r.Verdicts {
		if f.Verdict == v {
			return true
		}
	}
	return false
}

// redact hides a peer outside the reader's namespaces; true when it did.
func (r Request) redact(e *End) bool {
	if r.Scope == nil || e.Namespace == "" {
		return false
	}
	for _, ns := range r.Scope {
		if ns == e.Namespace {
			return false
		}
	}
	changed := e.Pod != "" || e.Workload != nil || e.Service != "" || e.Identity != 0
	e.Pod, e.Workload, e.Service, e.Identity = "", nil, "", 0
	return changed
}

// Result is the answer of Query, newest flow first.
type Result struct {
	Cluster string `json:"cluster"`
	Mode    string `json:"mode"`
	// Provider is what served the flows: hubble (a Hubble Relay) or calico (Calico's Whisker, at Relay).
	Provider  string `json:"provider,omitempty"`
	Relay     string `json:"relay"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind,omitempty"`
	Name      string `json:"name,omitempty"`
	Since     string `json:"since"`
	Flows     []Flow `json:"flows"`
	// Lost is how many events Hubble reported lost while answering.
	Lost uint64 `json:"lost_events,omitempty"`
	// Truncated: the Relay returned as many flows as asked, so there may be more.
	Truncated bool `json:"truncated"`
	// Redacted: peers outside the reader's namespaces are shown by namespace and address only.
	Redacted bool `json:"redacted,omitempty"`
	// Groups folds the flows of one connection (Hubble reports each step of a
	// packet, at the source's egress and the destination's ingress, and the
	// replies): same ends, port, protocol and verdict.
	Groups []Group `json:"groups"`
}

// Group is the flows of one connection, most recent first by Last.
type Group struct {
	Source      End    `json:"source"`
	Destination End    `json:"destination"`
	Protocol    string `json:"protocol,omitempty"`
	// Observed lists where the flows were seen: egress, ingress.
	Observed   []string  `json:"observed"`
	Verdict    string    `json:"verdict"`
	DropReason string    `json:"drop_reason,omitempty"`
	Policies   *Policies `json:"policies,omitempty"`
	// Count is the flows from source to destination, Replies those back.
	Count   int       `json:"count"`
	Replies int       `json:"replies"`
	First   time.Time `json:"first"`
	Last    time.Time `json:"last"`
}

func endKey(e End) string {
	w := ""
	if e.Workload != nil {
		w = e.Workload.Kind + "/" + e.Workload.Name
	}
	return strings.Join([]string{e.Namespace, e.Pod, w, e.IP}, "|")
}

// group folds flows (newest first) into connections, in the order of their newest flow.
func group(flows []Flow) []Group {
	out := []Group{}
	index := map[string]int{}
	for _, f := range flows {
		src, dst := f.Source, f.Destination
		if f.IsReply { // a reply belongs to the connection it answers
			src, dst = f.Destination, f.Source
		}
		src.Port, src.Names = 0, nil // the client port changes per connection
		dst.Names = nil
		key := strings.Join([]string{endKey(src), endKey(dst), fmt.Sprint(dst.Port), f.Protocol, f.Verdict, f.DropReason}, "#")
		i, ok := index[key]
		if !ok {
			i = len(out)
			index[key] = i
			out = append(out, Group{Source: src, Destination: dst, Protocol: f.Protocol, Observed: []string{}, Verdict: f.Verdict,
				DropReason: f.DropReason, First: f.Time, Last: f.Time})
		}
		g := &out[i]
		if f.Time.Before(g.First) {
			g.First = f.Time
		}
		if f.IsReply {
			g.Replies++
			continue
		}
		if f.Count > 0 { // an aggregated record (Calico)
			g.Count += f.Count
			g.Replies += f.ReplyCount
		} else {
			g.Count++
		}
		if f.Direction != "" && !contains(g.Observed, f.Direction) {
			g.Observed = append(g.Observed, f.Direction)
			sort.Strings(g.Observed)
		}
		g.Policies = mergePolicies(g.Policies, f.Policies)
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// mergePolicies adds b's policies to a, once each.
func mergePolicies(a, b *Policies) *Policies {
	if b == nil {
		return a
	}
	if a == nil {
		a = &Policies{}
	}
	add := func(dst *[]PolicyRef, src []PolicyRef) {
		for _, p := range src {
			found := false
			for _, q := range *dst {
				if q == p {
					found = true
					break
				}
			}
			if !found {
				*dst = append(*dst, p)
			}
		}
	}
	add(&a.EgressAllowedBy, b.EgressAllowedBy)
	add(&a.IngressAllowedBy, b.IngressAllowedBy)
	add(&a.EgressDeniedBy, b.EgressDeniedBy)
	add(&a.IngressDeniedBy, b.IngressDeniedBy)
	return a
}

// Query asks a Relay at url through client for the last flows of the
// request; the caller fills in where they came from.
func (s *Store) Query(ctx context.Context, client *http.Client, url string, req Request, now time.Time) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Timeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(frame(encodeRequest(uint64(req.Limit), req.filters()))))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/grpc")
	httpReq.Header.Set("TE", "trailers")
	resp, err := client.Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, statusError(resp)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/grpc") {
		return nil, fmt.Errorf("%w: the answer is %q, not gRPC", ErrUnavailable, ct)
	}
	if err := grpcStatus(resp.Header); err != nil {
		return nil, err
	}
	var flows []Flow
	var lost uint64
	err = readMessages(resp.Body, func(msg []byte) error {
		r, err := decodeResponse(msg)
		if err != nil {
			return fmt.Errorf("%w: unreadable flow: %v", ErrUnavailable, err)
		}
		lost += r.lost
		if r.flow != nil {
			flows = append(flows, *r.flow)
		}
		return nil
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ErrTimeout
		}
		return nil, err
	}
	if resp.Trailer.Get("Grpc-Status") == "" && resp.Header.Get("Grpc-Status") == "" {
		return nil, fmt.Errorf("%w: the answer ended without a gRPC status", ErrUnavailable)
	}
	if err := grpcStatus(resp.Trailer); err != nil {
		return nil, err
	}
	truncated := len(flows) >= req.Limit
	for i, j := 0, len(flows)-1; i < j; i, j = i+1, j-1 { // the Relay answers oldest first
		flows[i], flows[j] = flows[j], flows[i]
	}
	res := s.keep(ctx, req, flows, now, truncated)
	res.Lost = lost
	return res, nil
}

// Read asks the target's flow source: a Hubble Relay's GetFlows, or Calico's Whisker.
func (s *Store) Read(ctx context.Context, t Target, client *http.Client, url string, req Request, now time.Time) (*Result, error) {
	var res *Result
	var err error
	if t.Calico() {
		res, err = s.queryWhisker(ctx, client, url, req, now)
	} else {
		res, err = s.Query(ctx, client, url, req, now)
	}
	if res != nil {
		res.Provider = SourceHubble
		if t.Calico() {
			res.Provider = SourceCalico
		}
	}
	return res, err
}

// keep fills in what the flows (newest first) leave out, keeps those of the window that the request asked for,
// up to its limit, with the peers outside the reader's scope hidden, and folds them into connections.
func (s *Store) keep(ctx context.Context, req Request, flows []Flow, now time.Time, truncated bool) *Result {
	fill(ctx, req.Lookup, flows)
	cutoff := now.Add(-req.Since)
	out := []Flow{}
	redacted := false
	for _, f := range flows {
		if f.Time.Before(cutoff) || !req.matches(f) {
			continue
		}
		if len(out) == req.Limit {
			truncated = true
			break
		}
		if req.redact(&f.Source) {
			redacted = true
		}
		if req.redact(&f.Destination) {
			redacted = true
		}
		out = append(out, f)
	}
	return &Result{
		Namespace: req.Namespace, Kind: req.Kind, Name: req.Name, Since: req.Since.String(),
		Flows: out, Truncated: truncated, Redacted: redacted, Groups: group(out),
	}
}

func statusError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	detail := strings.TrimSpace(string(body))
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w: the cluster refused the Relay read (%d): %s", ErrForbidden, resp.StatusCode, detail)
	case http.StatusNotFound:
		return fmt.Errorf("%w: no Hubble Relay Service there (404): %s", ErrRelayMissing, detail)
	case http.StatusServiceUnavailable, http.StatusBadGateway:
		return fmt.Errorf("%w (%d): %s — the API server reaches the Relay over HTTP/2 only with Relay TLS on (hubble.relay.tls.server.enabled=true)", ErrUnavailable, resp.StatusCode, detail)
	}
	return fmt.Errorf("%w (%d): %s", ErrUnavailable, resp.StatusCode, detail)
}

// grpcStatus turns a non-zero grpc-status into an error.
func grpcStatus(h http.Header) error {
	st := h.Get("Grpc-Status")
	if st == "" || st == "0" {
		return nil
	}
	msg := h.Get("Grpc-Message")
	base := ErrUnavailable
	switch st {
	case "3": // InvalidArgument
		base = ErrInvalidRequest
	case "4": // DeadlineExceeded
		base = ErrTimeout
	case "7", "16": // PermissionDenied, Unauthenticated
		base = ErrForbidden
	}
	return fmt.Errorf("%w: relay grpc-status %s: %s", base, st, msg)
}
