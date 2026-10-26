package nfm

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/networkflowmonitor"
	"github.com/aws/aws-sdk-go-v2/service/networkflowmonitor/types"
	"github.com/aws/smithy-go"
	"golang.org/x/time/rate"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/netflows"
)

var (
	ErrInvalidRequest = errors.New("invalid request")
	ErrForbidden      = errors.New("forbidden")
	ErrNoMonitor      = errors.New("no such monitor")
	ErrUnavailable    = errors.New("network flow monitor unavailable")
	ErrTimeout        = errors.New("network flow monitor did not answer in time")
	ErrBusy           = errors.New("network flow monitor is throttling")
)

// Metrics a read ranks by: the three the EKS agent's flows carry (round trip time is not among them).
var Metrics = map[string]types.MonitorMetric{
	"DATA_TRANSFERRED": types.MonitorMetricDataTransferred,
	"RETRANSMISSIONS":  types.MonitorMetricRetransmissions,
	"TIMEOUTS":         types.MonitorMetricTimeouts,
}

// Views group the categories the EKS agent sorts flows into as the EKS console's flow table does: within the
// cluster, to AWS services, and to the internet or on-premises.
var Views = map[string][]types.DestinationCategory{
	"cluster":  {types.DestinationCategoryIntraAz, types.DestinationCategoryInterAz},
	"aws":      {types.DestinationCategoryAmazonS3, types.DestinationCategoryAmazonDynamodb},
	"external": {types.DestinationCategoryUnclassified},
}

// Kinds a read can name, besides the whole namespace.
var Kinds = netflows.Kinds

// API is what a read uses of the NFM client (*networkflowmonitor.Client).
type API interface {
	StartQueryMonitorTopContributors(context.Context, *networkflowmonitor.StartQueryMonitorTopContributorsInput, ...func(*networkflowmonitor.Options)) (*networkflowmonitor.StartQueryMonitorTopContributorsOutput, error)
	GetQueryStatusMonitorTopContributors(context.Context, *networkflowmonitor.GetQueryStatusMonitorTopContributorsInput, ...func(*networkflowmonitor.Options)) (*networkflowmonitor.GetQueryStatusMonitorTopContributorsOutput, error)
	GetQueryResultsMonitorTopContributors(context.Context, *networkflowmonitor.GetQueryResultsMonitorTopContributorsInput, ...func(*networkflowmonitor.Options)) (*networkflowmonitor.GetQueryResultsMonitorTopContributorsOutput, error)
	StopQueryMonitorTopContributors(context.Context, *networkflowmonitor.StopQueryMonitorTopContributorsInput, ...func(*networkflowmonitor.Options)) (*networkflowmonitor.StopQueryMonitorTopContributorsOutput, error)
}

// Store runs the reads: one NFM client, a short cache and a per-user budget.
type Store struct {
	cfg  Config
	api  API
	poll time.Duration
	now  func() time.Time

	mu       sync.Mutex
	cache    map[string]cached
	limiters map[string]*rate.Limiter
}

type cached struct {
	at   time.Time
	rows []types.MonitorTopContributorsRow
	unit string
	full bool
}

// New makes the store and its NFM client: the SDK's default credentials (IRSA), or the keys in SecretDir.
func New(cfg Config) (*Store, error) {
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(cfg.Region)}
	if cfg.SecretDir != "" {
		id, err := readSecret(cfg.SecretDir, "accessKeyId")
		if err != nil {
			return nil, err
		}
		key, err := readSecret(cfg.SecretDir, "secretAccessKey")
		if err != nil {
			return nil, err
		}
		if (id == "") != (key == "") {
			return nil, errors.New("the network flow monitor Secret needs both accessKeyId and secretAccessKey (or neither, for IRSA)")
		}
		if id != "" {
			opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(id, key, "")))
		}
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(), opts...)
	if err != nil {
		return nil, fmt.Errorf("network flow monitor client: %w", err)
	}
	client := networkflowmonitor.NewFromConfig(awsCfg, func(o *networkflowmonitor.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
	})
	return newStore(cfg, client), nil
}

func newStore(cfg Config, api API) *Store {
	return &Store{cfg: cfg, api: api, poll: 500 * time.Millisecond, now: time.Now, cache: map[string]cached{}, limiters: map[string]*rate.Limiter{}}
}

func readSecret(dir, name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// Config is the store's configuration.
func (s *Store) Config() Config { return s.cfg }

// Monitor is the monitor of a cluster, if any.
func (s *Store) Monitor(cluster string) (string, bool) {
	m, ok := s.cfg.Clusters[cluster]
	return m, ok && m != ""
}

// Allow takes one read from the user's budget.
func (s *Store) Allow(user string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	lim, ok := s.limiters[user]
	if !ok {
		lim = rate.NewLimiter(rate.Every(time.Minute/time.Duration(s.cfg.PerUserPerMinute)), s.cfg.PerUserPerMinute)
		s.limiters[user] = lim
	}
	return lim.Allow()
}

// Request is what to read: the rows with the namespace, a pod or a workload at either end.
type Request struct {
	Namespace string
	Kind      string // "" for the whole namespace
	Name      string
	Metric    string // a key of Metrics; default DATA_TRANSFERRED
	View      string // a key of Views; default cluster
	Range     time.Duration
	// Scope is a namespace-scoped reader's namespaces (nil = the whole cluster).
	Scope []string
	// Lookup lists pods as the reader: it names the workloads of the pods NFM names, and an end in a namespace
	// it cannot list (or outside Scope) shows its namespace and address only.
	Lookup netflows.Lookup
}

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
	if r.Metric == "" {
		r.Metric = "DATA_TRANSFERRED"
	}
	if _, ok := Metrics[r.Metric]; !ok {
		return fmt.Errorf("%w: metric %q (DATA_TRANSFERRED, RETRANSMISSIONS or TIMEOUTS)", ErrInvalidRequest, r.Metric)
	}
	if r.View == "" {
		r.View = "cluster"
	}
	if _, ok := Views[r.View]; !ok {
		return fmt.Errorf("%w: view %q (cluster, aws or external)", ErrInvalidRequest, r.View)
	}
	if r.Range == 0 {
		r.Range = s.cfg.DefaultRange
	}
	if r.Range < time.Minute || r.Range > s.cfg.MaxRange {
		return fmt.Errorf("%w: range must be between 1m and %s", ErrInvalidRequest, s.cfg.MaxRange)
	}
	return nil
}

// End is one side of a row: a pod (namespace, name, workload), a Service name, an address.
type End struct {
	Namespace string             `json:"namespace,omitempty"`
	Pod       string             `json:"pod,omitempty"`
	Workload  *netflows.Workload `json:"workload,omitempty"`
	Service   string             `json:"service,omitempty"`
	IP        string             `json:"ip,omitempty"`
	AZ        string             `json:"az,omitempty"`
	VPC       string             `json:"vpc,omitempty"`
	Instance  string             `json:"instance,omitempty"`
}

// Row is one top contributor: the local end (where the NFM agent measured) and the remote one.
type Row struct {
	Local    End    `json:"local"`
	Remote   End    `json:"remote"`
	Port     int32  `json:"port,omitempty"`
	Value    int64  `json:"value"`
	Category string `json:"category"`
}

// Result is the answer of Read, the largest value first.
type Result struct {
	Cluster   string `json:"cluster"`
	Monitor   string `json:"monitor"`
	Namespace string `json:"namespace"`
	Kind      string `json:"kind,omitempty"`
	Name      string `json:"name,omitempty"`
	Metric    string `json:"metric"`
	Unit      string `json:"unit,omitempty"`
	View      string `json:"view"`
	Range     string `json:"range"`
	Rows      []Row  `json:"rows"`
	// Truncated: NFM gave as many rows as asked in a category, so the target may have more.
	Truncated bool `json:"truncated"`
	Redacted  bool `json:"redacted,omitempty"`
}

// Read asks the cluster's monitor for the top contributors of the request's metric in each category of its
// view, over the range ending at the current minute, and keeps the rows of the request's target.
func (s *Store) Read(ctx context.Context, cluster string, req Request) (*Result, error) {
	monitor, ok := s.Monitor(cluster)
	if !ok {
		return nil, fmt.Errorf("%w: cluster %s has no monitor", ErrNoMonitor, cluster)
	}
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Timeout)
	defer cancel()
	end := s.now().UTC().Truncate(time.Minute)
	start := end.Add(-req.Range)
	res := &Result{Cluster: cluster, Monitor: monitor, Namespace: req.Namespace, Kind: req.Kind, Name: req.Name, Metric: req.Metric, View: req.View, Range: req.Range.String(), Rows: []Row{}}
	var all []Row
	for _, cat := range Views[req.View] {
		rows, unit, full, err := s.top(ctx, monitor, Metrics[req.Metric], cat, start, end)
		if err != nil {
			return nil, err
		}
		if unit != "" {
			res.Unit = unit
		}
		res.Truncated = res.Truncated || full
		for _, r := range rows {
			all = append(all, rowOf(r))
		}
	}
	var near []Row // a row of the namespace at either end, before its workloads are known
	for _, r := range all {
		if r.Local.Namespace == req.Namespace || r.Remote.Namespace == req.Namespace {
			near = append(near, r)
		}
	}
	hidden := fill(ctx, req.Lookup, near)
	for _, r := range near {
		if !req.side(r.Local) && !req.side(r.Remote) {
			continue
		}
		if req.redact(&r.Local, hidden) {
			res.Redacted = true
		}
		if req.redact(&r.Remote, hidden) {
			res.Redacted = true
		}
		res.Rows = append(res.Rows, r)
	}
	sort.SliceStable(res.Rows, func(i, j int) bool { return res.Rows[i].Value > res.Rows[j].Value })
	return res, nil
}

// top runs one query (start, wait, read every page), or answers from the cache for the same minute.
func (s *Store) top(ctx context.Context, monitor string, metric types.MonitorMetric, cat types.DestinationCategory, start, end time.Time) ([]types.MonitorTopContributorsRow, string, bool, error) {
	key := strings.Join([]string{monitor, string(metric), string(cat), start.Format(time.RFC3339), end.Format(time.RFC3339)}, "|")
	s.mu.Lock()
	if c, ok := s.cache[key]; ok {
		s.mu.Unlock()
		return c.rows, c.unit, c.full, nil
	}
	s.mu.Unlock()

	started, err := s.api.StartQueryMonitorTopContributors(ctx, &networkflowmonitor.StartQueryMonitorTopContributorsInput{
		MonitorName: aws.String(monitor), StartTime: aws.Time(start), EndTime: aws.Time(end),
		MetricName: metric, DestinationCategory: cat, Limit: aws.Int32(int32(s.cfg.Limit)),
	})
	if err != nil {
		return nil, "", false, s.apiError(ctx, err)
	}
	id := aws.ToString(started.QueryId)
	stop := func() { // a query left running costs the monitor's quota; best effort
		bg, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = s.api.StopQueryMonitorTopContributors(bg, &networkflowmonitor.StopQueryMonitorTopContributorsInput{MonitorName: aws.String(monitor), QueryId: aws.String(id)})
	}
	for {
		st, err := s.api.GetQueryStatusMonitorTopContributors(ctx, &networkflowmonitor.GetQueryStatusMonitorTopContributorsInput{MonitorName: aws.String(monitor), QueryId: aws.String(id)})
		if err != nil {
			stop()
			return nil, "", false, s.apiError(ctx, err)
		}
		if st.Status == types.QueryStatusSucceeded {
			break
		}
		if st.Status == types.QueryStatusFailed || st.Status == types.QueryStatusCanceled {
			return nil, "", false, fmt.Errorf("%w: the %s query %s", ErrUnavailable, cat, strings.ToLower(string(st.Status)))
		}
		select {
		case <-ctx.Done():
			stop()
			return nil, "", false, ErrTimeout
		case <-time.After(s.poll):
		}
	}
	var rows []types.MonitorTopContributorsRow
	unit := ""
	var next *string
	for {
		page, err := s.api.GetQueryResultsMonitorTopContributors(ctx, &networkflowmonitor.GetQueryResultsMonitorTopContributorsInput{
			MonitorName: aws.String(monitor), QueryId: aws.String(id), MaxResults: aws.Int32(500), NextToken: next,
		})
		if err != nil {
			return nil, "", false, s.apiError(ctx, err)
		}
		rows = append(rows, page.TopContributors...)
		if page.Unit != "" {
			unit = string(page.Unit)
		}
		if next = page.NextToken; aws.ToString(next) == "" || len(rows) >= s.cfg.Limit {
			break
		}
	}
	full := len(rows) >= s.cfg.Limit
	s.mu.Lock()
	for k, c := range s.cache { // keep a few minutes
		if s.now().Sub(c.at) > 5*time.Minute {
			delete(s.cache, k)
		}
	}
	s.cache[key] = cached{at: s.now(), rows: rows, unit: unit, full: full}
	s.mu.Unlock()
	return rows, unit, full, nil
}

func (s *Store) apiError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ErrTimeout
	}
	var ae smithy.APIError
	if errors.As(err, &ae) {
		switch ae.ErrorCode() {
		case "AccessDeniedException", "UnrecognizedClientException", "InvalidSignatureException", "ExpiredTokenException":
			return fmt.Errorf("%w: AWS refused the read (%s): %s", ErrForbidden, ae.ErrorCode(), ae.ErrorMessage())
		case "ResourceNotFoundException":
			return fmt.Errorf("%w: %s", ErrNoMonitor, ae.ErrorMessage())
		case "ValidationException":
			return fmt.Errorf("%w: %s", ErrInvalidRequest, ae.ErrorMessage())
		case "ThrottlingException", "ServiceQuotaExceededException":
			return fmt.Errorf("%w: %s", ErrBusy, ae.ErrorMessage())
		}
		return fmt.Errorf("%w: %s: %s", ErrUnavailable, ae.ErrorCode(), ae.ErrorMessage())
	}
	return fmt.Errorf("%w: %v", ErrUnavailable, err)
}

func rowOf(r types.MonitorTopContributorsRow) Row {
	k := r.KubernetesMetadata
	if k == nil {
		k = &types.KubernetesMetadata{}
	}
	return Row{
		Local: End{Namespace: aws.ToString(k.LocalPodNamespace), Pod: aws.ToString(k.LocalPodName), Service: aws.ToString(k.LocalServiceName),
			IP: aws.ToString(r.LocalIp), AZ: aws.ToString(r.LocalAz), VPC: aws.ToString(r.LocalVpcId), Instance: aws.ToString(r.LocalInstanceId)},
		Remote: End{Namespace: aws.ToString(k.RemotePodNamespace), Pod: aws.ToString(k.RemotePodName), Service: aws.ToString(k.RemoteServiceName),
			IP: aws.ToString(r.RemoteIp), AZ: aws.ToString(r.RemoteAz), VPC: aws.ToString(r.RemoteVpcId), Instance: aws.ToString(r.RemoteInstanceId)},
		Port: aws.ToInt32(r.TargetPort), Value: aws.ToInt64(r.Value), Category: string(r.DestinationCategory),
	}
}

// fill names the workloads of the pods, one list per namespace as the reader, and returns the namespaces it
// could not list: refused, or past netflows.MaxLookupNamespaces.
func fill(ctx context.Context, l netflows.Lookup, rows []Row) map[string]bool {
	hidden := map[string]bool{}
	if l == nil {
		return hidden
	}
	byNamespace := map[string]map[string]netflows.Workload{}
	for i := range rows {
		for _, e := range []*End{&rows[i].Local, &rows[i].Remote} {
			if e.Namespace == "" || hidden[e.Namespace] {
				continue
			}
			m, ok := byNamespace[e.Namespace]
			if !ok {
				var err error
				if len(byNamespace) < netflows.MaxLookupNamespaces {
					m, err = l.Workloads(ctx, e.Namespace)
				}
				if err != nil || len(byNamespace) >= netflows.MaxLookupNamespaces {
					hidden[e.Namespace] = true
					continue
				}
				byNamespace[e.Namespace] = m
			}
			if w, ok := m[e.Pod]; ok && e.Pod != "" {
				e.Workload = &w
			}
		}
	}
	return hidden
}

func (r Request) side(e End) bool {
	if e.Namespace != r.Namespace {
		return false
	}
	switch r.Kind {
	case "":
		return true
	case "Pod":
		return e.Pod == r.Name
	default:
		return e.Workload != nil && e.Workload.Kind == r.Kind && e.Workload.Name == r.Name
	}
}

// redact keeps only the namespace and the address of an end the reader may not see: outside its scope, or in
// a namespace whose pods it cannot list.
func (r Request) redact(e *End, hidden map[string]bool) bool {
	if e.Namespace == "" {
		return false
	}
	if !hidden[e.Namespace] {
		if r.Scope == nil {
			return false
		}
		for _, ns := range r.Scope {
			if ns == e.Namespace {
				return false
			}
		}
	}
	changed := e.Pod != "" || e.Workload != nil || e.Service != ""
	e.Pod, e.Workload, e.Service = "", nil, ""
	return changed
}
