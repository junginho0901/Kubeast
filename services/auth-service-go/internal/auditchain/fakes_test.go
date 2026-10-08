package auditchain

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// fakeStore keeps the chain in memory with the same rules as PG.
type fakeStore struct {
	rows       []Row
	unsealed   []Unsealed
	anchors    []Anchor
	reviews    []ReviewHash
	busy       bool
	sealErr    error
	since      time.Time
	until      time.Time
	batchCalls []int
}

func (f *fakeStore) head() Head {
	if len(f.rows) == 0 {
		return Head{Seq: 0, Hash: Genesis}
	}
	r := f.rows[len(f.rows)-1]
	return Head{Seq: r.Seq, Hash: r.Hash}
}

func (f *fakeStore) SealBatch(_ context.Context, limit int) (int, Head, error) {
	if f.busy {
		return 0, Head{}, ErrBusy
	}
	if f.sealErr != nil {
		return 0, Head{}, f.sealErr
	}
	f.batchCalls = append(f.batchCalls, limit)
	n := limit
	if n > len(f.unsealed) {
		n = len(f.unsealed)
	}
	sealed, head := sealRows(f.head(), f.unsealed[:n])
	for i, s := range sealed {
		f.rows = append(f.rows, Row{Seq: s.Seq, ID: s.ID, Prev: s.Prev, Hash: s.Hash, Canon: f.unsealed[i].Canon})
	}
	f.unsealed = f.unsealed[n:]
	return n, head, nil
}

func (f *fakeStore) Head(context.Context) (Head, error) { return f.head(), nil }

func (f *fakeStore) Bounds(context.Context) (oldest, newest, unsealed int64, err error) {
	if len(f.rows) > 0 {
		oldest, newest = f.rows[0].Seq, f.rows[len(f.rows)-1].Seq
	}
	return oldest, newest, int64(len(f.unsealed)), nil
}

func (f *fakeStore) Rows(_ context.Context, from, to int64, limit int) ([]Row, error) {
	var out []Row
	for _, r := range f.rows {
		if r.Seq >= from && r.Seq <= to {
			out = append(out, r)
			if len(out) == limit {
				break
			}
		}
	}
	return out, nil
}

func (f *fakeStore) LastAnchor(context.Context) (*Anchor, error) {
	if len(f.anchors) == 0 {
		return nil, nil
	}
	a := f.anchors[len(f.anchors)-1]
	return &a, nil
}

func (f *fakeStore) AnchorsIn(_ context.Context, from, to int64) ([]Anchor, error) {
	out := []Anchor{}
	for _, a := range f.anchors {
		if a.ToSeq >= from && a.ToSeq <= to {
			out = append(out, a)
		}
	}
	return out, nil
}

func (f *fakeStore) InsertAnchor(_ context.Context, a Anchor) (int64, error) {
	a.ID = int64(len(f.anchors) + 1)
	f.anchors = append(f.anchors, a)
	return a.ID, nil
}

func (f *fakeStore) ReviewHashesBetween(_ context.Context, since, until time.Time) ([]ReviewHash, error) {
	f.since, f.until = since, until
	out := []ReviewHash{}
	for _, r := range f.reviews {
		if r.ReviewedAt.After(since) && !r.ReviewedAt.After(until) {
			out = append(out, r)
		}
	}
	return out, nil
}

func (f *fakeStore) ReviewHashes(_ context.Context, ids []string) (map[string][]byte, error) {
	out := map[string][]byte{}
	for _, id := range ids {
		for _, r := range f.reviews {
			if r.ID == id {
				out[id] = r.Hash
			}
		}
	}
	return out, nil
}

// chainOf returns a store with n sealed rows (ids 101.., canon "<id>\x1frow-<i>").
func chainOf(n int) *fakeStore {
	f := &fakeStore{}
	for i := 1; i <= n; i++ {
		f.unsealed = append(f.unsealed, Unsealed{ID: int64(100 + i), Canon: fmt.Sprintf("%d\x1frow-%d", 100+i, i)})
	}
	f.SealBatch(context.Background(), n)
	return f
}

type fakeObjects struct {
	objects map[string][]byte
	meta    map[string]map[string]string
	putErr  error
}

func newFakeObjects() *fakeObjects {
	return &fakeObjects{objects: map[string][]byte{}, meta: map[string]map[string]string{}}
}

func (o *fakeObjects) PutObject(_ context.Context, key string, body []byte, _ string, meta map[string]string) error {
	if o.putErr != nil {
		return o.putErr
	}
	o.objects[key] = append([]byte(nil), body...)
	o.meta[key] = meta
	return nil
}

func (o *fakeObjects) GetObject(_ context.Context, key string) ([]byte, error) {
	b, ok := o.objects[key]
	if !ok {
		return nil, errors.New("no such object: " + key)
	}
	return b, nil
}

type memAudit struct{ recs []audit.Record }

func (m *memAudit) Write(_ context.Context, rec audit.Record) (int64, error) {
	m.recs = append(m.recs, rec)
	return int64(len(m.recs)), nil
}
