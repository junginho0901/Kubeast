package auditchain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// ActionAnchor is the audit action written for every scheduled anchor
// (docs/audit-log-plan.md §5-2); the admin's "anchor now" is admin.audit.anchor.
const ActionAnchor = "audit.chain.anchor"

// scheduledActor is the actor of the scheduled anchors.
const scheduledActor = "system"

// driftTolerance is how much less than a period old another replica's
// scheduled anchor may be and still count as a period ago (tickers and node
// clocks drift).
const driftTolerance = time.Minute

// ObjectStore is the S3 sink the digests go to (auditsink.ObjectStore).
// Keys are relative to the sink's prefix.
type ObjectStore interface {
	PutObject(ctx context.Context, key string, body []byte, contentType string, meta map[string]string) error
	GetObject(ctx context.Context, key string) ([]byte, error)
}

// Digest is the JSON object written to the sink: the chain head for the
// positions (from_seq..to_seq] sealed since the previous anchor, a link to
// that anchor, and the hashes of the access review sign-offs made since.
// A digest is written even when no row was sealed, so "nothing happened"
// is itself anchored.
type Digest struct {
	Version       int            `json:"version"`
	CreatedAt     string         `json:"created_at"`
	FromSeq       int64          `json:"from_seq"`
	ToSeq         int64          `json:"to_seq"`
	Rows          int64          `json:"rows"`
	HeadHash      string         `json:"head_hash"`
	PrevAnchor    *DigestRef     `json:"prev_anchor"`
	AccessReviews []DigestReview `json:"access_reviews"`
	HashAlgorithm string         `json:"hash_algorithm"`
}

// DigestRef points at the previous digest object.
type DigestRef struct {
	ObjectKey string `json:"object_key"`
	Hash      string `json:"hash"`
}

// DigestReview is one access review sign-off: id and sha256 of its snapshot.
type DigestReview struct {
	ID         string `json:"id"`
	ReviewedAt string `json:"reviewed_at"`
	Hash       string `json:"hash"`
}

// Anchorer writes digests to the sink and records them in audit_anchors.
type Anchorer struct {
	Store   Store
	Objects ObjectStore
	Sink    string
	Audit   audit.Writer // may be nil (tests)
	Now     func() time.Time

	lastAt atomic.Int64 // unix seconds of the newest anchor this replica knows of
	ownID  atomic.Int64 // id of the last scheduled anchor this replica wrote
}

func (a *Anchorer) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// Run anchors right away when the last anchor is older than `every` (or
// there is none), then every `every`, until ctx is done.
func (a *Anchorer) Run(ctx context.Context, every time.Duration) {
	if last, err := a.Store.LastAnchor(ctx); err != nil {
		slog.Error("audit chain: last anchor", "error", err)
	} else if last == nil || a.now().Sub(last.CreatedAt) >= every {
		a.RunOnce(ctx, every)
	} else {
		a.lastAt.Store(last.CreatedAt.Unix())
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.RunOnce(ctx, every)
		}
	}
}

// RunOnce is the scheduled anchor of a period: written as the system actor
// under the anchor lock and recorded as audit.chain.anchor (success or
// failure). It writes and records nothing (wrote false) when the last
// scheduled anchor is another replica's and less than every-driftTolerance
// old: that replica anchored this period. After its own anchor a replica
// writes the next one, so a single replica anchors every period.
func (a *Anchorer) RunOnce(ctx context.Context, every time.Duration) (anchor Anchor, wrote bool, err error) {
	done := false
	err = a.Store.AnchorLocked(ctx, func(s Store) error {
		last, err := s.LastAnchorBy(ctx, scheduledActor)
		if err != nil {
			return err
		}
		if last != nil && last.ID != a.ownID.Load() && a.now().Sub(last.CreatedAt) < every-driftTolerance {
			done = true
			a.saw(last.CreatedAt)
			return nil
		}
		anchor, err = a.write(ctx, s, scheduledActor)
		return err
	})
	if err == nil && done {
		return Anchor{}, false, nil
	}
	if err == nil {
		a.ownID.Store(anchor.ID)
		a.saw(anchor.CreatedAt)
	} else {
		anchor = Anchor{}
	}
	a.record(ctx, anchor, err)
	if err != nil {
		slog.Error("audit chain: anchor failed", "error", err)
		return anchor, false, err
	}
	slog.Info("audit chain: anchored", "from_seq", anchor.FromSeq, "to_seq", anchor.ToSeq, "rows", anchor.Rows, "object", anchor.ObjectKey)
	return anchor, true, nil
}

// AnchorOnce writes one digest for everything sealed since the previous
// anchor and returns the audit_anchors row. It waits for an anchor another
// replica is writing and builds on it. The caller records the audit action
// (RunOnce for the schedule, the admin handler for "anchor now").
func (a *Anchorer) AnchorOnce(ctx context.Context, actor string) (Anchor, error) {
	var anchor Anchor
	err := a.Store.AnchorLocked(ctx, func(s Store) error {
		var err error
		anchor, err = a.write(ctx, s, actor)
		return err
	})
	if err != nil {
		return Anchor{}, err
	}
	a.saw(anchor.CreatedAt)
	return anchor, nil
}

// write builds the digest from s (the anchor lock's transaction), puts it in
// the sink and inserts its audit_anchors row.
func (a *Anchorer) write(ctx context.Context, s Store, actor string) (Anchor, error) {
	now := a.now().UTC()
	head, err := s.Head(ctx)
	if err != nil {
		return Anchor{}, err
	}
	prev, err := s.LastAnchor(ctx)
	if err != nil {
		return Anchor{}, err
	}
	var from, since = int64(1), time.Time{}
	if prev != nil {
		from, since = prev.ToSeq+1, prev.CreatedAt
	} else if oldest, _, _, err := s.Bounds(ctx); err != nil {
		return Anchor{}, err
	} else if oldest > 0 {
		from = oldest
	}
	to := head.Seq
	rows := to - from + 1
	if rows < 0 {
		rows, to = 0, from-1
	}
	reviews, err := s.ReviewHashesBetween(ctx, since, now)
	if err != nil {
		return Anchor{}, err
	}
	d := Digest{Version: 1, CreatedAt: now.Format(time.RFC3339), FromSeq: from, ToSeq: to, Rows: rows, HeadHash: hex.EncodeToString(head.Hash), AccessReviews: []DigestReview{}, HashAlgorithm: "SHA-256"}
	if prev != nil {
		d.PrevAnchor = &DigestRef{ObjectKey: prev.ObjectKey, Hash: hex.EncodeToString(prev.AnchorHash)}
	}
	for _, r := range reviews {
		d.AccessReviews = append(d.AccessReviews, DigestReview{ID: r.ID, ReviewedAt: r.ReviewedAt.UTC().Format(time.RFC3339), Hash: hex.EncodeToString(r.Hash)})
	}
	body, err := json.Marshal(d)
	if err != nil {
		return Anchor{}, err
	}
	sum := sha256.Sum256(body)
	anchor := Anchor{CreatedAt: now, FromSeq: from, ToSeq: to, Rows: rows, HeadHash: head.Hash, AnchorHash: sum[:], Sink: a.Sink, Actor: actor,
		ObjectKey: fmt.Sprintf("digests/%s/%s-%d-%d.json", now.Format("2006/01/02"), now.Format("150405Z"), from, to)}
	if prev != nil {
		anchor.PrevAnchorHash = prev.AnchorHash
	}
	if err := a.Objects.PutObject(ctx, anchor.ObjectKey, body, "application/json", map[string]string{"anchor-hash": hex.EncodeToString(anchor.AnchorHash)}); err != nil {
		return Anchor{}, fmt.Errorf("anchor sink %s: %w", a.Sink, err)
	}
	id, err := s.InsertAnchor(ctx, anchor)
	if err != nil {
		return Anchor{}, err
	}
	anchor.ID = id
	return anchor, nil
}

func (a *Anchorer) saw(t time.Time) {
	if u := t.Unix(); u > a.lastAt.Load() {
		a.lastAt.Store(u)
	}
}

// LastAt is when the newest anchor this replica knows of was written: its
// own, or the one another replica wrote for a period this replica left to it
// (unix seconds, 0 = never).
func (a *Anchorer) LastAt() int64 { return a.lastAt.Load() }

func (a *Anchorer) record(ctx context.Context, anchor Anchor, err error) {
	if a.Audit == nil {
		return
	}
	rec := audit.Record{Service: audit.ServiceAuth, Action: ActionAnchor, ActorUserID: "system", ActorEmail: "system", TargetType: "audit-chain", TargetID: a.Sink, Result: audit.ResultSuccess}
	if err != nil {
		rec.Result, rec.Error = audit.ResultFailure, err.Error()
	} else {
		rec.After = audit.MustJSON(AnchorSummary(anchor))
	}
	if _, werr := a.Audit.Write(ctx, rec); werr != nil {
		slog.Error("audit chain: audit write failed", "error", werr)
	}
}

// AnchorSummary is the `after` payload of the anchor audit actions.
func AnchorSummary(a Anchor) map[string]any {
	return map[string]any{"from_seq": a.FromSeq, "to_seq": a.ToSeq, "rows": a.Rows, "object_key": a.ObjectKey, "anchor_hash": hex.EncodeToString(a.AnchorHash), "sink": a.Sink}
}
