package auditchain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"
)

func verify(t *testing.T, f *fakeStore, from, to int64, objects ObjectStore, withObjects bool) Report {
	t.Helper()
	rep, err := Verifier{Store: f, Objects: objects, Page: 4}.Verify(context.Background(), from, to, withObjects)
	if err != nil {
		t.Fatal(err)
	}
	return rep
}

func TestVerifyAcceptsAnIntactChainAndAnySegmentOfIt(t *testing.T) {
	f := chainOf(10)
	rep := verify(t, f, 1, 10, nil, false)
	if !rep.OK || rep.FromSeq != 1 || rep.ToSeq != 10 || rep.Rows != 10 || rep.Reason != "" {
		t.Fatalf("report = %+v", rep)
	}
	// A segment stands on its own: its first row carries its prev_hash.
	seg := verify(t, f, 6, 8, nil, false)
	if !seg.OK || seg.FromSeq != 6 || seg.ToSeq != 8 || seg.Rows != 3 {
		t.Fatalf("segment = %+v", seg)
	}
	// Rows purged before the oldest one are not a break.
	f.rows = f.rows[3:]
	purged := verify(t, f, 1, 10, nil, false)
	if !purged.OK || purged.FromSeq != 4 || purged.Rows != 7 {
		t.Fatalf("after purge = %+v", purged)
	}
}

func TestVerifyDetectsAChangedRow(t *testing.T) {
	f := chainOf(10)
	f.rows[4].Canon += "x" // seq 5 edited in place
	rep := verify(t, f, 1, 10, nil, false)
	if rep.OK || rep.FirstBadSeq != 5 || rep.Reason != "hash_mismatch" {
		t.Fatalf("report = %+v", rep)
	}
}

func TestVerifyDetectsADeletedRow(t *testing.T) {
	f := chainOf(10)
	f.rows = append(f.rows[:6], f.rows[7:]...) // seq 7 gone
	rep := verify(t, f, 1, 10, nil, false)
	if rep.OK || rep.FirstBadSeq != 7 || rep.Reason != "gap" {
		t.Fatalf("report = %+v", rep)
	}
}

func TestVerifyDetectsARowRewrittenWithItsOwnHashes(t *testing.T) {
	// Someone replaces seq 3 by a row that hashes correctly against a made-up
	// prev: the link from seq 2 is broken.
	f := chainOf(10)
	fake := RowHash(Genesis, "forged prev")
	f.rows[2].Prev = fake
	f.rows[2].Hash = RowHash(fake, f.rows[2].Canon)
	rep := verify(t, f, 1, 10, nil, false)
	if rep.OK || rep.FirstBadSeq != 3 || rep.Reason != "chain_break" {
		t.Fatalf("report = %+v", rep)
	}
}

func TestVerifyRefusesTooLargeARange(t *testing.T) {
	_, err := Verifier{Store: chainOf(1)}.Verify(context.Background(), 1, MaxVerifyRows+1, false)
	if err != ErrTooMany {
		t.Fatalf("err = %v", err)
	}
}

func TestVerifyComparesAnchorsWithTheChainAndTheSink(t *testing.T) {
	f := chainOf(10)
	objects := newFakeObjects()
	now := time.Date(2026, 10, 8, 0, 5, 0, 0, time.UTC)
	f.reviews = []ReviewHash{{ID: "rev-1", ReviewedAt: now.Add(-time.Hour), Hash: RowHash(Genesis, "snapshot")}}
	a := &Anchorer{Store: f, Objects: objects, Sink: "archive", Now: func() time.Time { return now }}
	if _, err := a.AnchorOnce(context.Background(), "system"); err != nil {
		t.Fatal(err)
	}
	rep := verify(t, f, 1, 10, objects, true)
	if !rep.OK || len(rep.Anchors) != 1 || !rep.Anchors[0].HeadOK || rep.Anchors[0].ObjectOK == nil || !*rep.Anchors[0].ObjectOK || rep.Anchors[0].ReviewsOK == nil || !*rep.Anchors[0].ReviewsOK {
		t.Fatalf("report = %+v anchors = %+v", rep, rep.Anchors)
	}
	// Without objects only the head is compared.
	rep = verify(t, f, 1, 10, objects, false)
	if !rep.OK || rep.Anchors[0].ObjectOK != nil {
		t.Fatalf("report without objects = %+v", rep.Anchors)
	}
	// The digest object rewritten in the sink: its hash no longer matches the anchor row.
	key := f.anchors[0].ObjectKey
	objects.objects[key] = append(objects.objects[key], ' ')
	rep = verify(t, f, 1, 10, objects, true)
	if rep.OK || rep.Reason != "anchor_mismatch" || *rep.Anchors[0].ObjectOK {
		t.Fatalf("rewritten object: report = %+v anchors = %+v", rep, rep.Anchors)
	}
	// The review snapshot changed in the database: the digest lists its old hash.
	objects.objects[key] = objects.objects[key][:len(objects.objects[key])-1]
	f.reviews[0].Hash = RowHash(Genesis, "edited snapshot")
	rep = verify(t, f, 1, 10, objects, true)
	if rep.OK || rep.Anchors[0].ReviewsOK == nil || *rep.Anchors[0].ReviewsOK || rep.Anchors[0].Error == "" {
		t.Fatalf("changed review: report = %+v anchors = %+v", rep, rep.Anchors)
	}
	// The whole database rewritten after the anchor: the head no longer matches.
	f.reviews[0].Hash = RowHash(Genesis, "snapshot")
	f.rows[9].Canon += "x"
	f.rows[9].Hash = RowHash(f.rows[9].Prev, f.rows[9].Canon)
	rep = verify(t, f, 1, 10, objects, false)
	if rep.OK || rep.Anchors[0].HeadOK {
		t.Fatalf("rewritten head: report = %+v anchors = %+v", rep, rep.Anchors)
	}
	// Sanity: the digest in the sink is what the anchor row says it is.
	var d Digest
	_ = json.Unmarshal(objects.objects[key], &d)
	sum := sha256.Sum256(objects.objects[key])
	if hex.EncodeToString(sum[:]) != hex.EncodeToString(f.anchors[0].AnchorHash) || d.ToSeq != 10 || d.Rows != 10 || len(d.AccessReviews) != 1 {
		t.Fatalf("digest = %+v", d)
	}
}

func TestDefaultRangeStartsAtTheLastAnchor(t *testing.T) {
	f := chainOf(10)
	from, to, err := DefaultRange(context.Background(), f)
	if err != nil || from != 1 || to != 10 {
		t.Fatalf("no anchor: %d..%d %v", from, to, err)
	}
	f.anchors = append(f.anchors, Anchor{ID: 1, FromSeq: 4, ToSeq: 8, Rows: 5})
	if from, to, _ = DefaultRange(context.Background(), f); from != 4 || to != 10 {
		t.Fatalf("with anchor: %d..%d", from, to)
	}
	f.anchors = append(f.anchors, Anchor{ID: 2, FromSeq: 9, ToSeq: 8, Rows: 0})
	if from, _, _ = DefaultRange(context.Background(), f); from != 1 {
		t.Fatalf("empty last anchor should fall back to the oldest row: from = %d", from)
	}
}
