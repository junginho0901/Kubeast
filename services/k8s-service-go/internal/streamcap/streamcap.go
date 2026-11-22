// Package streamcap counts the terminals (pod exec, node shell) and the followed logs (a container's output, a log file)
// each account holds open on this server, so that one account cannot fill the server with them (threat model row 1.6).
// A new one past its account's cap is refused before it opens; a place is given back when its connection ends. The
// server's cap counts every account's terminals and followed logs together, so many accounts under their own caps
// cannot fill it either.
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

// CloseCode is the close code of a terminal's socket refused at its account's cap or the server's: in the range RFC 6455
// §7.4.2 leaves to applications, as auth.SessionEndedCloseCode (4401) is HTTP's 401, this is HTTP's 429 Too Many
// Requests.
const CloseCode = 4429

// TerminalReason is the close reason of a terminal refused at its account's cap.
const TerminalReason = "terminal_limit"

// Event is the event a followed log refused at its account's cap gets, with FollowedLogReason as its data, or at the
// server's cap, with ServerReason.
const Event = "stream-limit"

// FollowedLogReason is the data of Event.
const FollowedLogReason = "followed_log_limit"

// ServerReason is the close reason of a terminal, and the data of Event for a followed log, refused at the server's
// cap: the close code and the event are those of an account's cap.
const ServerReason = "server_stream_limit"

// Refusal says whether a place was taken and, if not, which cap refused it.
type Refusal int

const (
	Taken     Refusal = iota // not refused
	ByAccount                // the account holds its cap of the kind
	ByServer                 // every account together holds the server's cap
)

type key struct {
	account string
	kind    Kind
}

// Caps holds the places of one server. A nil *Caps refuses nothing.
type Caps struct {
	mu            sync.Mutex
	max           [2]int
	server        int
	open          map[key]int
	total         int
	refused       [2]atomic.Uint64
	serverRefused [2]atomic.Uint64
}

// New returns Caps allowing each account terminals terminals and followedLogs followed logs at once; 0 is no cap for
// that kind (the chart refuses a value below 0, which counts as 0 here). It sets no cap on the server.
func New(terminals, followedLogs int) *Caps {
	return NewWithServerCap(terminals, followedLogs, 0)
}

// NewWithServerCap is New with a cap of server on the terminals and followed logs of every account together, 0 for
// none (below 0 counts as 0).
func NewWithServerCap(terminals, followedLogs, server int) *Caps {
	return &Caps{max: [2]int{max(0, terminals), max(0, followedLogs)}, server: max(0, server), open: map[key]int{}}
}

// ServerMax is the server's cap, 0 for none.
func (c *Caps) ServerMax() int {
	if c == nil {
		return 0
	}
	return c.server
}

// Max is the cap of kind, 0 for none.
func (c *Caps) Max(kind Kind) int {
	if c == nil {
		return 0
	}
	return c.max[kind]
}

// Take holds one place of kind for account. ok is false when the account already holds its cap or the server its own,
// and release then does nothing. Otherwise release gives the place back; calling it more than once gives it back once.
func (c *Caps) Take(account string, kind Kind) (release func(), ok bool) {
	release, refusal := c.Try(account, kind)
	return release, refusal == Taken
}

// Try is Take saying which cap refused the place. The account's cap is looked at first: when both are full the account
// is told to close one of its own, which gives the server a place back too.
func (c *Caps) Try(account string, kind Kind) (release func(), refusal Refusal) {
	if c == nil {
		return func() {}, Taken
	}
	k := key{account, kind}
	c.mu.Lock()
	if c.max[kind] > 0 && c.open[k] >= c.max[kind] {
		c.mu.Unlock()
		c.refused[kind].Add(1)
		return func() {}, ByAccount
	}
	if c.server > 0 && c.total >= c.server {
		c.mu.Unlock()
		c.serverRefused[kind].Add(1)
		return func() {}, ByServer
	}
	c.open[k]++
	c.total++
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			defer c.mu.Unlock()
			c.total--
			if c.open[k] <= 1 {
				delete(c.open, k)
				return
			}
			c.open[k]--
		})
	}, Taken
}

// Total is how many places of every account and kind are held now.
func (c *Caps) Total() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.total
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

// Refused is how many places of kind were refused at their account's cap since start
// (kubeast_stream_cap_refusals_total).
func (c *Caps) Refused(kind Kind) uint64 {
	if c == nil {
		return 0
	}
	return c.refused[kind].Load()
}

// ServerRefused is how many places of kind were refused at the server's cap since start
// (kubeast_stream_server_cap_refusals_total).
func (c *Caps) ServerRefused(kind Kind) uint64 {
	if c == nil {
		return 0
	}
	return c.serverRefused[kind].Load()
}
