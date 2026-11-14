package k8s

import (
	"sync"
	"time"
)

// accessAnswers are the access checks' answers this process got from the clusters, each kept until its end. They decide
// what a caller is shown of the reads made as kubeast:cache, so they stay in this process and out of the shared cache:
// every replica asks the cluster for itself.
type accessAnswers struct {
	mu   sync.RWMutex
	kept map[string]accessAnswer
	// sweepAt is the count at which set next drops the ended answers.
	sweepAt int
}

type accessAnswer struct {
	allowed bool
	end     int64 // unix nanoseconds
}

// accessAnswersSweepMin is how many answers are kept before set looks for ended ones. Each ends within podAccessTTL, so
// what stays is the questions answered in the last minute.
const accessAnswersSweepMin = 1024

// get is key's answer while it lasts.
func (a *accessAnswers) get(key string, now time.Time) (allowed, ok bool) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	e, found := a.kept[key]
	if !found || e.end <= now.UnixNano() {
		return false, false
	}
	return e.allowed, true
}

// set keeps key's answer until end.
func (a *accessAnswers) set(key string, allowed bool, end time.Time) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.kept == nil {
		a.kept = map[string]accessAnswer{}
	}
	a.kept[key] = accessAnswer{allowed: allowed, end: end.UnixNano()}
	if len(a.kept) < max(a.sweepAt, accessAnswersSweepMin) {
		return
	}
	now := time.Now().UnixNano()
	for k, e := range a.kept {
		if e.end <= now {
			delete(a.kept, k)
		}
	}
	// Twice what stayed, so the walk does not run on every set of a full map.
	a.sweepAt = 2 * len(a.kept)
}

// clear drops every answer (a cluster's bundle rebuilt).
func (a *accessAnswers) clear() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.kept, a.sweepAt = nil, 0
}
