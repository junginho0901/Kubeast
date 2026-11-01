// Package queue decides which builds run when many arrive at once — the
// first of the CI design's five layers against a crowd: a cap on running
// builds, a fair share per repository, the rest waiting in order with a
// position to show, and a newer push replacing the older build of the
// same branch. The rules are the ones CI services document: GitHub
// Actions' concurrency groups (a pending run is replaced by the newer one,
// a running one is cancelled with cancel-in-progress), GitLab's
// auto-cancel redundant pipelines with interruptible jobs, and Buildkite's
// skip and cancel intermediate builds, which a branch filter such as
// "!main" can leave out.
//
// The queue only decides; the controller creates and deletes the Jobs it
// is told to, and rebuilds the queue from them after a restart.
package queue

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Build is one build waiting or running.
type Build struct {
	ID   string
	Repo string
	// Ref groups builds: a newer build of the same Repo and Ref replaces an
	// older one (refs/heads/<branch>, refs/tags/<tag>, refs/pull/<n>/head).
	Ref string
	SHA string
	// DefaultBranch: the ref is the repository's default branch, where a
	// running build is not cancelled unless the settings say so — it may
	// be the one that deploys.
	DefaultBranch bool
	Enqueued      time.Time

	grp string // Repo and Ref, made once when submitted
}

func (b Build) group() string {
	if b.grp != "" {
		return b.grp
	}
	return b.Repo + "\x00" + b.Ref
}

// Settings are what an installer turns. The zero value is the default.
type Settings struct {
	// MaxRunning builds at once. Zero: 10 (the company CI design's
	// maxRunners).
	MaxRunning int `json:"maxRunning,omitempty"`
	// MaxPerRepo running builds of one repository, so one busy repository
	// cannot hold every place. Zero: 5.
	MaxPerRepo int `json:"maxPerRepo,omitempty"`
	// MaxWaiting builds in the queue; beyond it a new build is refused
	// (polling offers it again later). Zero: 1000.
	MaxWaiting int `json:"maxWaiting,omitempty"`
	// KeepRunning leaves a running build alone when a newer push to its
	// branch arrives (the newer one waits). By default a running build is
	// cancelled, except on the default branch.
	KeepRunning bool `json:"keepRunning,omitempty"`
	// CancelDefaultBranch also cancels a running build of the default
	// branch when a newer push arrives.
	CancelDefaultBranch bool `json:"cancelDefaultBranch,omitempty"`
}

// Defaults.
const (
	DefaultMaxRunning = 10
	DefaultMaxPerRepo = 5
	DefaultMaxWaiting = 1000
)

// Validate refuses negative numbers and a repository share larger than
// the whole.
func (s Settings) Validate() error {
	if s.MaxRunning < 0 || s.MaxPerRepo < 0 || s.MaxWaiting < 0 {
		return errors.New("queue settings: negative numbers")
	}
	d := s.withDefaults()
	if d.MaxPerRepo > d.MaxRunning {
		return fmt.Errorf("queue settings: maxPerRepo %d is above maxRunning %d", d.MaxPerRepo, d.MaxRunning)
	}
	return nil
}

func (s Settings) withDefaults() Settings {
	if s.MaxRunning == 0 {
		s.MaxRunning = DefaultMaxRunning
	}
	if s.MaxPerRepo == 0 {
		s.MaxPerRepo = min(DefaultMaxPerRepo, s.MaxRunning)
	}
	if s.MaxWaiting == 0 {
		s.MaxWaiting = DefaultMaxWaiting
	}
	return s
}

// Decision is what the controller does after a change: start these
// builds' Jobs, delete these running builds' Jobs, and report these
// waiting builds as replaced.
type Decision struct {
	Start    []Build
	Cancel   []Build
	Replaced []Build
}

// Errors of Submit.
var (
	// ErrDuplicate: the same commit of the same branch is already waiting
	// or running (a webhook and a poll both saw it).
	ErrDuplicate = errors.New("queue: this commit is already queued or running")
	// ErrFull: MaxWaiting builds already wait.
	ErrFull = errors.New("queue: full")
)

// Queue is safe for concurrent use. A submit costs the same however many
// builds wait (branch indexes; the waiting list is only walked to replace
// a build or to fill a free place).
type Queue struct {
	s            Settings
	mu           sync.Mutex
	running      map[string]Build  // by ID
	runningGroup map[string]string // branch -> ID of its running build
	perRepo      map[string]int
	waiting      []Build           // oldest first
	waitingGroup map[string]string // branch -> ID of its waiting build
}

// New makes a queue; settings out of bounds are refused.
func New(s Settings) (*Queue, error) {
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &Queue{s: s.withDefaults(), running: map[string]Build{}, runningGroup: map[string]string{},
		perRepo: map[string]int{}, waitingGroup: map[string]string{}}, nil
}

// Submit adds a build. A waiting build of the same branch is replaced; a
// running one is cancelled unless the settings keep it; then free places
// are filled.
func (q *Queue) Submit(b Build) (Decision, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	b.grp = ""
	g := b.group()
	b.grp = g
	if id, ok := q.runningGroup[g]; ok && q.running[id].SHA == b.SHA {
		return Decision{}, ErrDuplicate
	}
	var d Decision
	if id, ok := q.waitingGroup[g]; ok {
		i := q.indexOf(id)
		if q.waiting[i].SHA == b.SHA {
			return Decision{}, ErrDuplicate
		}
		d.Replaced = append(d.Replaced, q.waiting[i])
		q.removeAt(i)
	} else if len(q.waiting) >= q.s.MaxWaiting {
		return Decision{}, ErrFull
	}
	q.waiting = append(q.waiting, b)
	q.waitingGroup[g] = b.ID

	if id, ok := q.runningGroup[g]; ok {
		r := q.running[id]
		if !q.s.KeepRunning && (!r.DefaultBranch || q.s.CancelDefaultBranch) {
			d.Cancel = append(d.Cancel, r)
			q.release(id)
		}
	}
	d.Start = q.fill()
	return d, nil
}

func (q *Queue) indexOf(id string) int {
	for i, w := range q.waiting {
		if w.ID == id {
			return i
		}
	}
	return -1
}

func (q *Queue) removeAt(i int) {
	delete(q.waitingGroup, q.waiting[i].group())
	copy(q.waiting[i:], q.waiting[i+1:])
	q.waiting[len(q.waiting)-1] = Build{}
	q.waiting = q.waiting[:len(q.waiting)-1]
}

// Finish frees a running build's place (it succeeded, failed or was
// cancelled) and fills free places.
func (q *Queue) Finish(id string) Decision {
	q.mu.Lock()
	defer q.mu.Unlock()
	if _, ok := q.running[id]; ok {
		q.release(id)
	}
	return Decision{Start: q.fill()}
}

// Remove takes a waiting build out (a person cancelled it). It reports
// whether the build was waiting.
func (q *Queue) Remove(id string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	i := q.indexOf(id)
	if i < 0 {
		return false
	}
	q.removeAt(i)
	return true
}

// Position is a waiting build's place in line, from 1, counting only the
// builds that wait ahead of it; 0 when it is not waiting. A build whose
// repository is at its share can be passed by builds of other
// repositories, so the position says the order, not a promise.
func (q *Queue) Position(id string) int {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, w := range q.waiting {
		if w.ID == id {
			return i + 1
		}
	}
	return 0
}

// Snapshot returns the running builds (by ID) and the waiting ones in order.
func (q *Queue) Snapshot() (running, waiting []Build) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, r := range q.running {
		running = append(running, r)
	}
	sortBuilds(running)
	return running, append([]Build(nil), q.waiting...)
}

func (q *Queue) release(id string) {
	r := q.running[id]
	delete(q.running, id)
	delete(q.runningGroup, r.group())
	if q.perRepo[r.Repo]--; q.perRepo[r.Repo] <= 0 {
		delete(q.perRepo, r.Repo)
	}
}

// fill starts waiting builds in order while places are free, passing over
// a build whose repository holds its share — or whose branch still has a
// running build — and coming back to it when that frees. With no free
// place it does not walk the list.
func (q *Queue) fill() []Build {
	if len(q.running) >= q.s.MaxRunning || len(q.waiting) == 0 {
		return nil
	}
	var started []Build
	kept := q.waiting[:0]
	for _, w := range q.waiting {
		if len(q.running) >= q.s.MaxRunning || q.perRepo[w.Repo] >= q.s.MaxPerRepo {
			kept = append(kept, w)
			continue
		}
		g := w.group()
		if _, busy := q.runningGroup[g]; !busy {
			q.running[w.ID] = w
			q.runningGroup[g] = w.ID
			q.perRepo[w.Repo]++
			delete(q.waitingGroup, g)
			started = append(started, w)
			continue
		}
		kept = append(kept, w)
	}
	for i := len(kept); i < len(q.waiting); i++ {
		q.waiting[i] = Build{}
	}
	q.waiting = kept
	return started
}

func sortBuilds(b []Build) {
	sort.Slice(b, func(i, j int) bool { return less(b[i], b[j]) })
}

// less orders builds by arrival, then ID.
func less(a, b Build) bool {
	if !a.Enqueued.Equal(b.Enqueued) {
		return a.Enqueued.Before(b.Enqueued)
	}
	return a.ID < b.ID
}
