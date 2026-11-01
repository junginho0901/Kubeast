package queue

import (
	"errors"
	"fmt"
	"sort"
)

// Restore puts builds that are already running back into a new queue, as a
// restarted controller finds their Jobs. They are taken past MaxRunning and
// MaxPerRepo, since they run anyway; new builds wait until places free up.
// Two running builds of one branch happen only after a crash between
// cancelling one build and starting the next: the newest stays and the
// others come back in Cancel, as a newer push would have cancelled them.
func (q *Queue) Restore(running []Build) (Decision, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.running) > 0 || len(q.waiting) > 0 {
		return Decision{}, errors.New("queue: restore into a queue that is in use")
	}
	seen := map[string]bool{}
	for _, b := range running {
		if b.ID == "" || b.Repo == "" || b.Ref == "" {
			return Decision{}, fmt.Errorf("queue: restore: build %q has no ID, repository or ref", b.ID)
		}
		if seen[b.ID] {
			return Decision{}, fmt.Errorf("queue: restore: build %s is listed twice", b.ID)
		}
		seen[b.ID] = true
	}
	sorted := append([]Build(nil), running...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if !sorted[i].Enqueued.Equal(sorted[j].Enqueued) {
			return sorted[i].Enqueued.Before(sorted[j].Enqueued)
		}
		return sorted[i].ID < sorted[j].ID
	})
	var d Decision
	for _, b := range sorted {
		b.grp = ""
		g := b.group()
		b.grp = g
		if id, ok := q.runningGroup[g]; ok {
			d.Cancel = append(d.Cancel, q.running[id])
			q.release(id)
		}
		q.running[b.ID] = b
		q.runningGroup[g] = b.ID
		q.perRepo[b.Repo]++
	}
	return d, nil
}
