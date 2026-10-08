package auditchain

import (
	"bytes"
	"context"
	"crypto/sha256"
	"testing"
)

func TestRowHashIsSHA256OfPrevSeparatorCanon(t *testing.T) {
	prev := bytes.Repeat([]byte{7}, HashSize)
	want := sha256.Sum256(append(append(append([]byte{}, prev...), 0x1e), []byte("42\x1fauth")...))
	if got := RowHash(prev, "42\x1fauth"); !bytes.Equal(got, want[:]) {
		t.Fatalf("RowHash = %x, want %x", got, want)
	}
	if bytes.Equal(RowHash(prev, "42\x1fauth"), RowHash(prev, "42\x1fauth ")) {
		t.Error("a changed canon must change the hash")
	}
	if bytes.Equal(RowHash(prev, "x"), RowHash(Genesis, "x")) {
		t.Error("a changed prev must change the hash")
	}
}

func TestSealRowsChainsInOrderFromTheHead(t *testing.T) {
	rows := []Unsealed{{ID: 9, Canon: "9\x1fa"}, {ID: 4, Canon: "4\x1fb"}, {ID: 12, Canon: "12\x1fc"}}
	sealed, head := sealRows(Head{Seq: 0}, rows)
	if len(sealed) != 3 || head.Seq != 3 || !bytes.Equal(head.Hash, sealed[2].Hash) {
		t.Fatalf("sealed = %+v head = %+v", sealed, head)
	}
	if !bytes.Equal(sealed[0].Prev, Genesis) || sealed[0].Seq != 1 || sealed[0].ID != 9 {
		t.Errorf("first row = %+v", sealed[0])
	}
	for i := 1; i < 3; i++ {
		if !bytes.Equal(sealed[i].Prev, sealed[i-1].Hash) || sealed[i].Seq != int64(i+1) {
			t.Errorf("row %d does not link to row %d: %+v", i, i-1, sealed[i])
		}
	}
	// Sealing more rows later continues from the head, not from genesis.
	more, head2 := sealRows(head, []Unsealed{{ID: 20, Canon: "20\x1fd"}})
	if more[0].Seq != 4 || !bytes.Equal(more[0].Prev, head.Hash) || head2.Seq != 4 {
		t.Errorf("continuation = %+v head = %+v", more, head2)
	}
}

func TestFakeStoreSealsLikeSealRows(t *testing.T) {
	f := chainOf(5)
	if len(f.rows) != 5 || f.rows[4].Seq != 5 || len(f.unsealed) != 0 {
		t.Fatalf("rows = %d unsealed = %d", len(f.rows), len(f.unsealed))
	}
	for i, r := range f.rows {
		if !bytes.Equal(RowHash(r.Prev, r.Canon), r.Hash) {
			t.Errorf("row %d hash does not recompute", i)
		}
	}
	oldest, newest, unsealed, _ := f.Bounds(context.Background())
	if oldest != 1 || newest != 5 || unsealed != 0 {
		t.Errorf("bounds = %d %d %d", oldest, newest, unsealed)
	}
}
