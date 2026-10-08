package auditchain

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestSealerRunOnceSealsEverythingBatchByBatch(t *testing.T) {
	f := &fakeStore{}
	for i := 1; i <= 25; i++ {
		f.unsealed = append(f.unsealed, Unsealed{ID: int64(i), Canon: fmt.Sprintf("%d\x1frow", i)})
	}
	s := &Sealer{Store: f, Batch: 10}
	n, err := s.RunOnce(context.Background())
	if err != nil || n != 25 || len(f.unsealed) != 0 || len(f.rows) != 25 {
		t.Fatalf("sealed %d err %v unsealed %d rows %d", n, err, len(f.unsealed), len(f.rows))
	}
	if len(f.batchCalls) != 3 || f.batchCalls[0] != 10 {
		t.Errorf("batch calls = %v, want three of 10 (the last one partial)", f.batchCalls)
	}
	if s.sealedSeq.Load() != 25 || s.unsealed.Load() != 0 {
		t.Errorf("gauges = %d / %d", s.sealedSeq.Load(), s.unsealed.Load())
	}
	// Nothing left: one empty batch, no error.
	if n, err := s.RunOnce(context.Background()); err != nil || n != 0 {
		t.Fatalf("idle run sealed %d err %v", n, err)
	}
}

func TestSealerRunOnceStopsQuietlyWhenAnotherReplicaSeals(t *testing.T) {
	f := &fakeStore{busy: true, unsealed: []Unsealed{{ID: 1, Canon: "1"}}}
	if n, err := (&Sealer{Store: f}).RunOnce(context.Background()); err != nil || n != 0 {
		t.Fatalf("busy: sealed %d err %v", n, err)
	}
	f = &fakeStore{sealErr: errors.New("db down"), unsealed: []Unsealed{{ID: 1, Canon: "1"}}}
	if _, err := (&Sealer{Store: f}).RunOnce(context.Background()); err == nil {
		t.Fatal("expected the store error")
	}
}
