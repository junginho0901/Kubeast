// Package streamcap counts the terminals (pod exec, node shell) and the followed logs (a container's output, a log file)
// each account holds open on this server, so that one account cannot fill the server with them (threat model row 1.6).
// A new one past its account's cap is refused before it opens; a place is given back when its connection ends.
//
// The counts live in this process: with several k8s-service (or k8s-service-stream) pods each counts its own, so an
// account may hold the cap on each pod (docs/high-availability.md).
package streamcap

import (
	"sync"
	"sync/atomic"
)

// Kind is what a place is taken for.
type Kind int

const (
	Terminal    Kind = iota // pod exec, node shell
	FollowedLog             // a container's output or a log file, followed
)

// CloseCode is the close code of a terminal's socket refused at its account's cap: in the range RFC 6455 §7.4.2 leaves
// to applications, as auth.SessionEndedCloseCode (4401) is HTTP's 401, this is HTTP's 429 Too Many Requests.
const CloseCode = 4429

// TerminalReason is the close reason of a terminal refused at its account's cap.
const TerminalReason = "terminal_limit"

// Event is the event a followed log refused at its account's cap gets, with FollowedLogReason as its data.
const Event = "stream-limit"

// FollowedLogReason is the data of Event.
const FollowedLogReason = "followed_log_limit"

type key struct {
	account string
	kind    Kind
}

// Caps holds the places of one server. A nil *Caps refuses nothing.
type Caps struct {
	mu      sync.Mutex
	max     [2]int
	open    map[key]int
	refused [2]atomic.Uint64
}

// New returns Caps allowing each account terminals terminals and followedLogs followed logs at once; 0 is no cap for
// that kind (the chart refuses a value below 0, which counts as 0 here).
func New(terminals, followedLogs int) *Caps {
	return &Caps{max: [2]int{max(0, terminals), max(0, followedLogs)}, open: map[key]int{}}
}

// Max is the cap of kind, 0 for none.
func (c *Caps) Max(kind Kind) int {
	if c == nil {
		return 0
	}
	return c.max[kind]
}

// Take holds one place of kind for account. ok is false when the account already holds the cap, and release then does
// nothing. Otherwise release gives the place back; calling it more than once gives it back once.
func (c *Caps) Take(account string, kind Kind) (release func(), ok bool) {
	if c == nil {
		return func() {}, true
	}
	k := key{account, kind}
	c.mu.Lock()
	if c.max[kind] > 0 && c.open[k] >= c.max[kind] {
		c.mu.Unlock()
		c.refused[kind].Add(1)
		return func() {}, false
	}
	c.open[k]++
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			if c.open[k] <= 1 {
				delete(c.open, k)
				return
			}
			c.open[k]--
		})
	}, true
}

// Open is how many places of kind account holds now.
func (c *Caps) Open(account string, kind Kind) int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.open[key{account, kind}]
}

// Accounts is how many accounts hold at least one place of any kind: an account that holds none takes no memory.
func (c *Caps) Accounts() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	seen := map[string]struct{}{}
	for k := range c.open {
		seen[k.account] = struct{}{}
	}
	return len(seen)
}

// Refused is how many places of kind were refused since start (kubeast_stream_cap_refusals_total).
func (c *Caps) Refused(kind Kind) uint64 {
	if c == nil {
		return 0
	}
	return c.refused[kind].Load()
}
