package helm

import (
	"context"
	"fmt"
)

// DiffRevisions returns a unified diff between two revisions of the same
// release, restricted to a single section (manifest or values). Notes /
// hooks diffs are allowed but rarely meaningful — the UI hides those
// tabs from the diff picker.
//
// The output format is standard unified diff (`diff --unified`) which
// the frontend renders with diff2html. Section labels become filenames
// so diff2html's file headers give useful context.
func (s *Service) DiffRevisions(ctx context.Context, namespace, name string, req DiffRequest) (*DiffResult, error) {
	if !req.Section.IsValid() {
		return nil, ErrInvalidSection
	}
	if req.From <= 0 || req.To <= 0 {
		return nil, ErrInvalidRevision
	}

	fromText, err := s.GetRevisionSection(ctx, namespace, name, req.From, req.Section)
	if err != nil {
		return nil, fmt.Errorf("from revision %d: %w", req.From, err)
	}
	toText, err := s.GetRevisionSection(ctx, namespace, name, req.To, req.Section)
	if err != nil {
		return nil, fmt.Errorf("to revision %d: %w", req.To, err)
	}

	fromLabel := fmt.Sprintf("%s/%s@%d.%s", namespace, name, req.From, req.Section)
	toLabel := fmt.Sprintf("%s/%s@%d.%s", namespace, name, req.To, req.Section)

	return &DiffResult{
		From:       req.From,
		To:         req.To,
		Section:    req.Section,
		Diff:       unifiedDiff(fromLabel, toLabel, fromText, toText),
		MaskedDiff: maskedDiff(fromLabel, toLabel, fromText, toText),
	}, nil
}
