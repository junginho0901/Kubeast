package webhook

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultMetaURL is GitHub's meta endpoint; GitHub Enterprise Server has
// its own under the instance's API root.
const DefaultMetaURL = "https://api.github.com/meta"

// DefaultMetaInterval is how often Ranges reads /meta again. GitHub changes
// its addresses "from time to time" and, for anyone who allows by address,
// "strongly encourage[s] regular monitoring of our API".
const DefaultMetaInterval = 6 * time.Hour

// Ranges holds GitHub's hook address ranges for Handler.Ranges and reads
// them again from /meta (ParseMetaHooks) now and then, swapping a new list
// in at once. A failed, empty or malformed read keeps the last good list.
// It asks with the last ETag, so an unchanged list is a 304, which does not
// count against the rate limit when the request carries a token. Safe for
// concurrent use.
type Ranges struct {
	URL      string // empty: DefaultMetaURL
	HTTP     *http.Client
	Interval time.Duration // empty: DefaultMetaInterval
	// Token, when set, authorizes the request (an installation token).
	Token func(context.Context) (string, error)

	cur  atomic.Pointer[[]netip.Prefix]
	mu   sync.Mutex // one read at a time
	etag string
	wait time.Duration // GitHub's x-poll-interval, if it sent one
}

// Loaded reports whether a list has been read.
func (r *Ranges) Loaded() bool { return r.cur.Load() != nil }

// Contains reports whether addr is in the list; false before the first
// good read, so deliveries are refused until GitHub's list is known (the
// commit still comes through polling).
func (r *Ranges) Contains(addr netip.Addr) bool {
	p := r.cur.Load()
	return p != nil && inAny(*p, addr.Unmap())
}

// Refresh reads /meta once and reports whether the list changed.
func (r *Ranges) Refresh(ctx context.Context) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	url := r.URL
	if url == "" {
		url = DefaultMetaURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if r.etag != "" && r.Loaded() {
		req.Header.Set("If-None-Match", r.etag)
	}
	if r.Token != nil {
		tok, err := r.Token(ctx)
		if err != nil {
			return false, fmt.Errorf("webhook: meta token: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	c := r.HTTP
	if c == nil {
		c = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := c.Do(req)
	if err != nil {
		return false, fmt.Errorf("webhook: meta: %w", err)
	}
	defer resp.Body.Close()
	if s, err := strconv.Atoi(resp.Header.Get("X-Poll-Interval")); err == nil && s > 0 {
		r.wait = time.Duration(s) * time.Second
	}
	switch resp.StatusCode {
	case http.StatusNotModified:
		return false, nil
	case http.StatusOK:
	default:
		return false, fmt.Errorf("webhook: meta: HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return false, fmt.Errorf("webhook: meta: %w", err)
	}
	hooks, err := ParseMetaHooks(body)
	if err != nil {
		return false, err
	}
	old := r.cur.Load()
	r.cur.Store(&hooks)
	r.etag = resp.Header.Get("ETag")
	return old == nil || !samePrefixes(*old, hooks), nil
}

// Run refreshes until ctx ends: at once, then every Interval (or GitHub's
// x-poll-interval when longer). report, when set, is told each result.
func (r *Ranges) Run(ctx context.Context, report func(changed bool, err error)) {
	for {
		changed, err := r.Refresh(ctx)
		if report != nil && !errors.Is(err, context.Canceled) {
			report(changed, err)
		}
		next := r.Interval
		if next <= 0 {
			next = DefaultMetaInterval
		}
		r.mu.Lock()
		if r.wait > next {
			next = r.wait
		}
		r.mu.Unlock()
		t := time.NewTimer(next)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

func samePrefixes(a, b []netip.Prefix) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[netip.Prefix]int, len(a))
	for _, p := range a {
		seen[p]++
	}
	for _, p := range b {
		if seen[p]--; seen[p] < 0 {
			return false
		}
	}
	return true
}
