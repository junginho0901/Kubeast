package webhook

import (
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"
)

// Path is the one route the controller serves deliveries on.
const Path = "/hooks/github"

// DefaultMaxBody is 1 MiB. GitHub caps payloads at 25 MB, but only the
// signal is read here, and a body is held whole to check its signature, so
// a small cap bounds the memory of concurrent deliveries. A larger push
// (a payload lists up to 2,048 commits) is refused with 413 and reaches the
// build through polling, which always runs.
const DefaultMaxBody = 1 << 20

// Rejection is a refused delivery, for metrics and the audit record
// (ci.webhook.reject). It never holds the body.
type Rejection struct {
	Status   int
	Reason   string
	Source   netip.Addr
	Event    string
	Delivery string
}

// Handler serves Path.
type Handler struct {
	Verifier   *Verifier
	Deliveries DeliveryStore
	// Enqueue hands an accepted event on without waiting; false means the
	// queue is full, and the delivery is answered 503 so it shows as failed
	// on GitHub and can be redelivered (polling picks the commit up too).
	Enqueue func(Event) bool
	// OnReject, when set, is told about every refused delivery.
	OnReject func(Rejection)
	MaxBody  int64
	// AllowedSources, when set, are the only source addresses taken —
	// GitHub's hook ranges from GET /meta (ParseMetaHooks).
	AllowedSources []netip.Prefix
	// Ranges, when set, is used instead of AllowedSources: the same list,
	// kept current by reading /meta again.
	Ranges *Ranges
	// TrustedProxies are the peers whose ClientIPHeader is believed, such
	// as a Cloudflare Tunnel connector (CF-Connecting-IP). Anyone else's
	// header is ignored and the peer address is the source.
	TrustedProxies []netip.Prefix
	ClientIPHeader string
	// Limit is per source: at most PerMinute deliveries a minute. Zero
	// turns it off.
	Limit *SourceLimit
	Now   func() time.Time
}

// ServeHTTP answers within the request: every check is local and the work
// is queued, well inside GitHub's 10 seconds.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	now := time.Now
	if h.Now != nil {
		now = h.Now
	}
	src := h.source(r)
	event := r.Header.Get("X-GitHub-Event")
	delivery := r.Header.Get("X-GitHub-Delivery")
	reject := func(status int, reason string) {
		if h.OnReject != nil {
			h.OnReject(Rejection{Status: status, Reason: reason, Source: src, Event: event, Delivery: delivery})
		}
		http.Error(w, reason, status)
	}

	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		reject(http.StatusMethodNotAllowed, "method")
		return
	}
	if (h.Ranges != nil && !h.Ranges.Contains(src)) || (h.Ranges == nil && len(h.AllowedSources) > 0 && !inAny(h.AllowedSources, src)) {
		reject(http.StatusForbidden, "source")
		return
	}
	if h.Limit != nil && !h.Limit.Allow(src, now()) {
		reject(http.StatusTooManyRequests, "rate")
		return
	}
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		// GitHub can also send x-www-form-urlencoded; the app is set to JSON.
		reject(http.StatusUnsupportedMediaType, "content-type")
		return
	}
	max := h.MaxBody
	if max <= 0 {
		max = DefaultMaxBody
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		reject(http.StatusBadRequest, "read")
		return
	}
	if int64(len(body)) > max {
		reject(http.StatusRequestEntityTooLarge, "too-large")
		return
	}

	res := h.Verifier.Check(event, delivery, r.Header.Get("X-Hub-Signature-256"), body)
	switch res.Outcome {
	case Rejected:
		status := http.StatusBadRequest
		if res.Reason == "no-signature" || res.Reason == "bad-signature" {
			status = http.StatusForbidden
		}
		reject(status, res.Reason)
		return
	case Ignored:
		if res.Reason == "ping" {
			w.WriteHeader(http.StatusOK)
			io.WriteString(w, "pong\n")
			return
		}
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, "ignored: "+res.Reason+"\n")
		return
	}

	// Signed and wanted: take each delivery ID once.
	if h.Deliveries.Seen(delivery, now()) {
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, "duplicate\n")
		return
	}
	if !h.Enqueue(res.Event) {
		reject(http.StatusServiceUnavailable, "queue-full")
		return
	}
	h.Deliveries.Take(delivery, now())
	w.WriteHeader(http.StatusAccepted)
	io.WriteString(w, "queued\n")
}

func (h *Handler) source(r *http.Request) netip.Addr {
	peer := addrOf(r.RemoteAddr)
	if h.ClientIPHeader != "" && inAny(h.TrustedProxies, peer) {
		if a, err := netip.ParseAddr(r.Header.Get(h.ClientIPHeader)); err == nil {
			return a.Unmap()
		}
	}
	return peer
}

func addrOf(remote string) netip.Addr {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return a.Unmap()
}

func inAny(prefixes []netip.Prefix, a netip.Addr) bool {
	if !a.IsValid() {
		return false
	}
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// SourceLimit counts deliveries per source address in one-minute windows.
// It keeps at most MaxSources addresses; past that, the addresses it does
// not know share one count, so a flood of new addresses cannot grow it.
type SourceLimit struct {
	PerMinute  int
	MaxSources int

	mu     sync.Mutex
	window time.Time
	counts map[netip.Addr]int
	others int
}

// NewSourceLimit allows perMinute deliveries a minute per address.
func NewSourceLimit(perMinute int) *SourceLimit {
	return &SourceLimit{PerMinute: perMinute, MaxSources: 10_000}
}

// Allow counts one delivery from a and reports whether it is within the
// limit.
func (l *SourceLimit) Allow(a netip.Addr, now time.Time) bool {
	if l.PerMinute <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if w := now.Truncate(time.Minute); !w.Equal(l.window) || l.counts == nil {
		l.window, l.counts, l.others = w, map[netip.Addr]int{}, 0
	}
	if _, ok := l.counts[a]; !ok && len(l.counts) >= l.MaxSources {
		l.others++
		return l.others <= l.PerMinute
	}
	l.counts[a]++
	return l.counts[a] <= l.PerMinute
}

// ErrNoHooks is returned when a GET /meta answer has no hook ranges.
var ErrNoHooks = errors.New("webhook: the meta answer lists no hook addresses")
