// Package accesstrail lists the Kubernetes API requests made for one AI tool
// call, each with the Audit-ID Kubeast sent, so the call can be found in the
// cluster's audit log. The API server takes a client's Audit-ID as the audit
// event's auditID and echoes it in the response (kube-apiserver audit_init.go).
package accesstrail

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"sync"
)

const (
	// HeaderRecord on a request asks the service to list the cluster requests
	// it makes for it; HeaderRequests on the response carries the Trail.
	HeaderRecord   = "X-Kubeast-Record"
	HeaderRequests = "X-Kubeast-Requests"
	HeaderAuditID  = "Audit-ID"
	// MaxRequests are kept per call; Total counts every one.
	MaxRequests = 20
)

// Request is one cluster request (Source "api") or one answer Kubeast gave
// from its own cache without asking the cluster (Source "cache").
type Request struct {
	Source      string `json:"source"`
	Verb        string `json:"verb,omitempty"`
	Group       string `json:"group,omitempty"`
	Resource    string `json:"resource,omitempty"`
	Subresource string `json:"subresource,omitempty"`
	Namespace   string `json:"namespace,omitempty"`
	Name        string `json:"name,omitempty"`
	// Path is set for a request that names no resource (/version, /healthz).
	Path   string `json:"path,omitempty"`
	Status int    `json:"status,omitempty"`
	Ms     int64  `json:"ms,omitempty"`
	// AuditID is what Kubeast sent; Echoed means the API server answered with it.
	AuditID string `json:"audit_id,omitempty"`
	Echoed  bool   `json:"echoed,omitempty"`
	// Cache names what answered a Source "cache" entry.
	Cache string `json:"cache,omitempty"`
}

// Trail is the requests of one call: the first MaxRequests and how many in all.
type Trail struct {
	Requests []Request `json:"requests"`
	Total    int       `json:"total"`
}

// Recorder collects a Trail; safe for concurrent use.
type Recorder struct {
	mu sync.Mutex
	t  Trail
}

func (r *Recorder) Add(req Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.t.Total++
	if len(r.t.Requests) < MaxRequests {
		r.t.Requests = append(r.t.Requests, req)
	}
}

// Merge adds a Trail another service returned.
func (r *Recorder) Merge(t Trail) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.t.Total += t.Total
	for _, req := range t.Requests {
		if len(r.t.Requests) == MaxRequests {
			break
		}
		r.t.Requests = append(r.t.Requests, req)
	}
}

func (r *Recorder) Snapshot() Trail {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Trail{Requests: append([]Request(nil), r.t.Requests...), Total: r.t.Total}
}

type ctxKey struct{}

func NewContext(ctx context.Context, r *Recorder) context.Context {
	return context.WithValue(ctx, ctxKey{}, r)
}

// FromContext is the call's Recorder, nil when nothing is being recorded.
func FromContext(ctx context.Context) *Recorder {
	r, _ := ctx.Value(ctxKey{}).(*Recorder)
	return r
}

// Cached notes an answer served from Kubeast's cache for the call in ctx.
func Cached(ctx context.Context, what string) {
	if r := FromContext(ctx); r != nil {
		r.Add(Request{Source: "cache", Cache: what})
	}
}

// NewAuditID is a fresh "kubeast-" + 32 hex characters.
func NewAuditID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "kubeast-" + hex.EncodeToString(b[:])
}

// Header renders t for HeaderRequests (base64url JSON).
func (t Trail) Header() string {
	b, _ := json.Marshal(t)
	return base64.RawURLEncoding.EncodeToString(b)
}

// ParseHeader reads a HeaderRequests value; false when absent or unreadable.
func ParseHeader(v string) (Trail, bool) {
	if v == "" {
		return Trail{}, false
	}
	b, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil {
		return Trail{}, false
	}
	var t Trail
	if json.Unmarshal(b, &t) != nil {
		return Trail{}, false
	}
	return t, true
}
