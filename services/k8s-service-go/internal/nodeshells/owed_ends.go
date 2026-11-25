package nodeshells

import (
	"context"
	"log/slog"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// maxOwedEnds bounds the end rows a process keeps to write later: past it the oldest is given up (its stdout copy
// stands). A process holds a few node shells at most, each of which owes one row.
const maxOwedEnds = 256

// owedEnd is an end row the audit store did not take, kept to be written once it takes rows again.
type owedEnd struct {
	seq uint64
	rec audit.Record
}

// WriteEnd writes the k8s.session.end row of a shell this server closed itself because it could not save the
// heartbeat (heartbeat_lost). The database is usually out with the heartbeat, so a row the store does not take now is
// kept and written once the database answers and the store is ready again (payOwed, at each beat tick and once when
// Run ends). The store's stdout copy of each try stands either way; a row this process stops before writing is lost
// to the database, as before. It says false, writing nothing, for a tracker with no audit writer (tests).
func (t *Tracker) WriteEnd(ctx context.Context, rec audit.Record) bool {
	if t.audit == nil {
		return false
	}
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), opTimeout)
	_, err := t.audit.Write(wctx, rec)
	cancel()
	if err == nil {
		return true
	}
	t.mu.Lock()
	t.owedSeq++
	t.owed = append(t.owed, owedEnd{seq: t.owedSeq, rec: rec})
	var dropped *owedEnd
	if len(t.owed) > maxOwedEnds {
		d := t.owed[0]
		dropped = &d
		t.owed = append([]owedEnd(nil), t.owed[1:]...)
	}
	owed := len(t.owed)
	t.mu.Unlock()
	slog.Warn("node shell: end row not written; this server writes it once the audit store takes rows again", "owed", owed, "err", err)
	if dropped != nil {
		slog.Warn("node shell: an end row owed too long is given up; its stdout copy stands", "target", dropped.rec.TargetID, "owed", owed)
	}
	return true
}

// Owed is how many end rows this process keeps to write.
func (t *Tracker) Owed() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.owed)
}

// payOwed writes the owed end rows, oldest first, once the database answers (the store's Ping) and the audit store is
// ready by a check of its own (audit.Checker: a refusal kept from the outage for a request is not its answer), or else
// by audit.Readier; it stops at the first row not taken, left to the next try. It runs on the heartbeat's
// goroutine after a beat, so it starts no row once a third of beatEvery has passed since it began and leaves the rest,
// in their order, to the next tick: with the beat's opTimeout and the last row's, a tick ends within beatEvery, and an
// audit store that takes rows slowly does not hold the next beat back.
func (t *Tracker) payOwed(ctx context.Context) {
	if t.Owed() == 0 || t.audit == nil {
		return
	}
	began, payFor := t.now(), t.beatEvery/3
	pctx, cancel := context.WithTimeout(ctx, opTimeout)
	err := t.store.Ping(pctx)
	cancel()
	t.answered(err)
	if err != nil {
		return
	}
	if c, ok := t.audit.(audit.Checker); ok {
		err = c.CheckReady(ctx)
	} else if rd, ok := t.audit.(audit.Readier); ok {
		err = rd.Ready(ctx)
	}
	if err != nil {
		return
	}
	for {
		t.mu.Lock()
		if len(t.owed) == 0 {
			t.mu.Unlock()
			return
		}
		next, owed := t.owed[0], len(t.owed)
		t.mu.Unlock()
		if t.now().Sub(began) >= payFor {
			slog.Info("node shell: owed end rows left to the next beat", "owed", owed)
			return
		}
		wctx, cancel := context.WithTimeout(ctx, opTimeout)
		_, err := t.audit.Write(wctx, next.rec)
		cancel()
		if err != nil {
			return
		}
		t.mu.Lock()
		for i, o := range t.owed {
			if o.seq == next.seq {
				t.owed = append(t.owed[:i:i], t.owed[i+1:]...)
				break
			}
		}
		left := len(t.owed)
		t.mu.Unlock()
		slog.Info("node shell: owed end row written", "target", next.rec.TargetID, "owed", left)
	}
}

// payOwedAtStop is payOwed's last try as Run ends (the server stopping), within opTimeout; what is left is logged.
func (t *Tracker) payOwedAtStop() {
	if t.Owed() == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	t.payOwed(ctx)
	if n := t.Owed(); n > 0 {
		slog.Warn("node shell: end rows not written before this server stopped; their stdout copies stand", "owed", n)
	}
}
