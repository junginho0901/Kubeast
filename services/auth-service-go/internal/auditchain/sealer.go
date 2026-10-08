package auditchain

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"
)

// Sealer chains unsealed rows every tick. Late-committed rows simply take the
// next position: the chain's order is the sealing order, the row id is part
// of the hashed content.
type Sealer struct {
	Store Store
	Batch int

	sealedSeq atomic.Int64
	unsealed  atomic.Int64
}

// Run seals once immediately and then every `every`, until ctx is done.
func (s *Sealer) Run(ctx context.Context, every time.Duration) {
	s.RunOnce(ctx)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.RunOnce(ctx)
		}
	}
}

// RunOnce seals every unsealed row (batch after batch) and returns how many
// it sealed; errors are logged, never fatal for the service.
func (s *Sealer) RunOnce(ctx context.Context) (int, error) {
	batch := s.Batch
	if batch <= 0 {
		batch = DefaultBatch
	}
	total := 0
	for {
		n, head, err := s.Store.SealBatch(ctx, batch)
		if errors.Is(err, ErrBusy) {
			return total, nil
		}
		if err != nil {
			slog.Error("audit chain: sealing failed", "error", err, "sealed", total)
			return total, err
		}
		total += n
		s.sealedSeq.Store(head.Seq)
		if n < batch {
			break
		}
	}
	if _, _, unsealed, err := s.Store.Bounds(ctx); err == nil {
		s.unsealed.Store(unsealed)
	}
	if total > 0 {
		slog.Info("audit chain: sealed", "rows", total, "through_seq", s.sealedSeq.Load())
	}
	return total, nil
}
