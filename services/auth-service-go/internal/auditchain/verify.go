package auditchain

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// MaxVerifyRows bounds one verification call; a longer range is verified in
// pieces (every piece stands on its own: a row carries its prev_hash).
const MaxVerifyRows = 200_000

// ErrTooMany is returned when the range exceeds MaxVerifyRows.
var ErrTooMany = fmt.Errorf("auditchain: range exceeds %d rows", MaxVerifyRows)

// Report is the outcome of one verification.
type Report struct {
	FromSeq     int64         `json:"from_seq"`
	ToSeq       int64         `json:"to_seq"`
	Rows        int64         `json:"rows"`
	OK          bool          `json:"ok"`
	FirstBadSeq int64         `json:"first_bad_seq,omitempty"`
	Reason      string        `json:"reason,omitempty"` // hash_mismatch | chain_break | gap
	Anchors     []AnchorCheck `json:"anchors"`
}

// AnchorCheck compares one anchor with the chain (and, when asked, with the
// digest object in the sink).
type AnchorCheck struct {
	ID        int64  `json:"id"`
	ToSeq     int64  `json:"to_seq"`
	ObjectKey string `json:"object_key"`
	HeadOK    bool   `json:"head_ok"`
	ObjectOK  *bool  `json:"object_ok,omitempty"`  // nil = not fetched
	ReviewsOK *bool  `json:"reviews_ok,omitempty"` // nil = not fetched
	Error     string `json:"error,omitempty"`
}

// Verifier recomputes a range of the chain.
type Verifier struct {
	Store   Store
	Objects ObjectStore // nil when no anchor sink
	Page    int
}

// Verify walks positions from..to, recomputing every hash and checking the
// links, then compares the anchors in the range. With withObjects it also
// fetches each digest from the sink and checks its hash and the access
// review snapshots it lists.
func (v Verifier) Verify(ctx context.Context, from, to int64, withObjects bool) (Report, error) {
	rep := Report{FromSeq: from, ToSeq: to, OK: true, Anchors: []AnchorCheck{}}
	if to < from {
		return rep, nil
	}
	if to-from+1 > MaxVerifyRows {
		return rep, ErrTooMany
	}
	page := v.Page
	if page <= 0 {
		page = 1000
	}
	// Anchors first: the walk keeps only the heads their to_seq points at.
	anchors, err := v.Store.AnchorsIn(ctx, from, to)
	if err != nil {
		return rep, err
	}
	heads := map[int64][]byte{}
	for _, a := range anchors {
		heads[a.ToSeq] = nil
	}
	var prevHash []byte
	var prevSeq int64
	first := true
	next := from
	for rep.OK {
		rows, err := v.Store.Rows(ctx, next, to, page)
		if err != nil {
			return rep, err
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			rep.Rows++
			if first {
				rep.FromSeq = r.Seq
				first = false
			} else if r.Seq != prevSeq+1 {
				rep.fail(prevSeq+1, "gap")
				break
			} else if !bytes.Equal(r.Prev, prevHash) {
				rep.fail(r.Seq, "chain_break")
				break
			}
			if !bytes.Equal(RowHash(r.Prev, r.Canon), r.Hash) {
				rep.fail(r.Seq, "hash_mismatch")
				break
			}
			if _, wanted := heads[r.Seq]; wanted {
				heads[r.Seq] = r.Hash
			}
			prevHash, prevSeq = r.Hash, r.Seq
		}
		if len(rows) < page || prevSeq >= to {
			break
		}
		next = prevSeq + 1
	}
	if rep.OK && rep.Rows > 0 {
		rep.ToSeq = prevSeq
	}
	for _, a := range anchors {
		if a.ToSeq < rep.FromSeq || a.ToSeq > rep.ToSeq {
			continue
		}
		c := AnchorCheck{ID: a.ID, ToSeq: a.ToSeq, ObjectKey: a.ObjectKey, HeadOK: bytes.Equal(heads[a.ToSeq], a.HeadHash)}
		if a.Rows == 0 {
			// An empty digest repeats the previous head; nothing of its own to compare.
			c.HeadOK = true
		}
		if withObjects && v.Objects != nil {
			v.checkObject(ctx, a, &c)
		}
		if !c.HeadOK || (c.ObjectOK != nil && !*c.ObjectOK) || (c.ReviewsOK != nil && !*c.ReviewsOK) {
			rep.OK = false
			if rep.Reason == "" {
				rep.Reason = "anchor_mismatch"
			}
		}
		rep.Anchors = append(rep.Anchors, c)
	}
	return rep, nil
}

func (r *Report) fail(seq int64, reason string) {
	r.OK, r.FirstBadSeq, r.Reason = false, seq, reason
}

func (v Verifier) checkObject(ctx context.Context, a Anchor, c *AnchorCheck) {
	body, err := v.Objects.GetObject(ctx, a.ObjectKey)
	if err != nil {
		c.Error = err.Error()
		f := false
		c.ObjectOK = &f
		return
	}
	sum := sha256.Sum256(body)
	ok := bytes.Equal(sum[:], a.AnchorHash)
	c.ObjectOK = &ok
	if !ok {
		return
	}
	var d Digest
	if err := json.Unmarshal(body, &d); err != nil {
		c.Error = "digest: " + err.Error()
		return
	}
	if len(d.AccessReviews) == 0 {
		t := true
		c.ReviewsOK = &t
		return
	}
	ids := make([]string, 0, len(d.AccessReviews))
	for _, r := range d.AccessReviews {
		ids = append(ids, r.ID)
	}
	have, err := v.Store.ReviewHashes(ctx, ids)
	if err != nil {
		c.Error = err.Error()
		return
	}
	reviewsOK := true
	for _, r := range d.AccessReviews {
		want, _ := hex.DecodeString(r.Hash)
		if got, found := have[r.ID]; !found || !bytes.Equal(got, want) {
			reviewsOK = false
			if !found {
				c.Error = "access review " + r.ID + " is missing"
			} else {
				c.Error = "access review " + r.ID + " changed"
			}
			break
		}
	}
	c.ReviewsOK = &reviewsOK
}

// DefaultRange is what a verification without an explicit range covers: from
// the last anchor's first position (or the oldest sealed row) to the newest.
func DefaultRange(ctx context.Context, s Store) (from, to int64, err error) {
	oldest, newest, _, err := s.Bounds(ctx)
	if err != nil {
		return 0, 0, err
	}
	from = oldest
	if last, err := s.LastAnchor(ctx); err != nil {
		return 0, 0, err
	} else if last != nil && last.Rows > 0 && last.FromSeq >= oldest {
		from = last.FromSeq
	}
	if newest-from+1 > MaxVerifyRows {
		from = newest - MaxVerifyRows + 1
	}
	return from, newest, nil
}
