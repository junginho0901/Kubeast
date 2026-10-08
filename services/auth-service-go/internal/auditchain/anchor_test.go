package auditchain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

func TestAnchorOnceWritesTheDigestAndLinksToThePreviousOne(t *testing.T) {
	f := chainOf(7)
	objects := newFakeObjects()
	now := time.Date(2026, 10, 8, 0, 5, 9, 0, time.UTC)
	f.reviews = []ReviewHash{{ID: "rev-old", ReviewedAt: now.Add(-48 * time.Hour), Hash: RowHash(Genesis, "old")}, {ID: "rev-new", ReviewedAt: now.Add(-time.Hour), Hash: RowHash(Genesis, "new")}}
	a := &Anchorer{Store: f, Objects: objects, Sink: "archive", Now: func() time.Time { return now }}

	first, err := a.AnchorOnce(context.Background(), "system")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != 1 || first.FromSeq != 1 || first.ToSeq != 7 || first.Rows != 7 || first.Sink != "archive" || first.Actor != "system" || first.PrevAnchorHash != nil {
		t.Fatalf("first anchor = %+v", first)
	}
	if first.ObjectKey != "digests/2026/10/08/000509Z-1-7.json" {
		t.Errorf("object key = %s", first.ObjectKey)
	}
	body := objects.objects[first.ObjectKey]
	sum := sha256.Sum256(body)
	if hex.EncodeToString(sum[:]) != hex.EncodeToString(first.AnchorHash) || objects.meta[first.ObjectKey]["anchor-hash"] != hex.EncodeToString(first.AnchorHash) {
		t.Error("anchor hash is not the sha256 of the object written, or is missing from its metadata")
	}
	var d Digest
	if err := json.Unmarshal(body, &d); err != nil {
		t.Fatal(err)
	}
	if d.Version != 1 || d.FromSeq != 1 || d.ToSeq != 7 || d.Rows != 7 || d.HeadHash != hex.EncodeToString(f.head().Hash) || d.PrevAnchor != nil || d.HashAlgorithm != "SHA-256" || d.CreatedAt != "2026-10-08T00:05:09Z" {
		t.Fatalf("digest = %+v", d)
	}
	if len(d.AccessReviews) != 2 || d.AccessReviews[1].ID != "rev-new" || !f.since.IsZero() || !f.until.Equal(now) {
		t.Fatalf("reviews in the first digest = %+v (since %v until %v)", d.AccessReviews, f.since, f.until)
	}

	// Two more rows, a later anchor: starts after the previous one, links to it,
	// lists only the sign-offs made since.
	f.unsealed = []Unsealed{{ID: 201, Canon: "201\x1fa"}, {ID: 202, Canon: "202\x1fb"}}
	f.SealBatch(context.Background(), 10)
	later := now.Add(24 * time.Hour)
	a.Now = func() time.Time { return later }
	second, err := a.AnchorOnce(context.Background(), "admin@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != 2 || second.FromSeq != 8 || second.ToSeq != 9 || second.Rows != 2 || second.Actor != "admin@example.com" || hex.EncodeToString(second.PrevAnchorHash) != hex.EncodeToString(first.AnchorHash) {
		t.Fatalf("second anchor = %+v", second)
	}
	_ = json.Unmarshal(objects.objects[second.ObjectKey], &d)
	if d.PrevAnchor == nil || d.PrevAnchor.ObjectKey != first.ObjectKey || d.PrevAnchor.Hash != hex.EncodeToString(first.AnchorHash) || len(d.AccessReviews) != 0 || !f.since.Equal(now) {
		t.Fatalf("second digest = %+v (since %v)", d, f.since)
	}

	// Nothing new: an empty digest is still written (rows 0, same head).
	a.Now = func() time.Time { return later.Add(24 * time.Hour) }
	third, err := a.AnchorOnce(context.Background(), "system")
	if err != nil || third.Rows != 0 || third.FromSeq != 10 || third.ToSeq != 9 || hex.EncodeToString(third.HeadHash) != hex.EncodeToString(second.HeadHash) {
		t.Fatalf("empty anchor = %+v err = %v", third, err)
	}
	if len(objects.objects) != 3 || len(f.anchors) != 3 {
		t.Fatalf("objects = %d anchors = %d", len(objects.objects), len(f.anchors))
	}
}

func TestAnchorOnceStartsAtTheOldestSealedRowAfterAPurge(t *testing.T) {
	f := chainOf(9)
	f.rows = f.rows[4:] // seq 1..4 purged before the first anchor
	a := &Anchorer{Store: f, Objects: newFakeObjects(), Sink: "archive"}
	anchor, err := a.AnchorOnce(context.Background(), "system")
	if err != nil || anchor.FromSeq != 5 || anchor.ToSeq != 9 || anchor.Rows != 5 {
		t.Fatalf("anchor = %+v err = %v", anchor, err)
	}
}

func TestRunOnceRecordsTheSystemAuditActionOnSuccessAndFailure(t *testing.T) {
	f := chainOf(3)
	objects := newFakeObjects()
	aud := &memAudit{}
	a := &Anchorer{Store: f, Objects: objects, Sink: "archive", Audit: aud}
	if _, err := a.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(aud.recs) != 1 || aud.recs[0].Action != ActionAnchor || aud.recs[0].ActorEmail != "system" || aud.recs[0].Result != audit.ResultSuccess || aud.recs[0].TargetID != "archive" {
		t.Fatalf("records = %+v", aud.recs)
	}
	var after map[string]any
	_ = json.Unmarshal(aud.recs[0].After, &after)
	if after["to_seq"] != float64(3) || after["rows"] != float64(3) || after["object_key"] == "" || after["anchor_hash"] == "" {
		t.Errorf("after = %v", after)
	}
	if a.LastAt() == 0 {
		t.Error("LastAt not set after a successful anchor")
	}
	objects.putErr = errors.New("bucket gone")
	if _, err := a.RunOnce(context.Background()); err == nil {
		t.Fatal("expected the put error")
	}
	if len(aud.recs) != 2 || aud.recs[1].Result != audit.ResultFailure || aud.recs[1].Error == "" {
		t.Fatalf("failure record = %+v", aud.recs[1])
	}
	if len(f.anchors) != 1 {
		t.Errorf("a failed put must not insert an anchor row: %d", len(f.anchors))
	}
}
