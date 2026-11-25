package logsearch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

// MaxEstimatedSelectors caps the stream selectors of one query whose volume is asked: each is one index read.
const MaxEstimatedSelectors = 8

// ErrTooLarge is a read whose estimated volume is past the limit it was given.
var ErrTooLarge = errors.New("the read is too large")

// Volume is what the store's index says the streams of a query hold over a range (Loki's
// GET /loki/api/v1/index/stats), asked before a read is made. Line filters are not in it. It is Loki's estimate, not
// the most a read can go through: the lines the ingesters hold and have not flushed yet are left out, so a range over
// the last hours can come out smaller than it is or empty, it is counted by a probabilistic method, and a stream or
// chunk that spans two schema_config periods may be counted twice. It is meant to stop a long range, whose chunks the
// index holds, before it is read.
type Volume struct {
	Streams int64 `json:"streams"`
	Chunks  int64 `json:"chunks"`
	Entries int64 `json:"entries"`
	Bytes   int64 `json:"bytes"`
}

// indexStats asks store's index for the volume of the streams selector matches in [start, end].
func (l *loki) indexStats(ctx context.Context, store Store, selector string, start, end time.Time) (Volume, error) {
	params := url.Values{}
	params.Set("query", selector)
	params.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	params.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	body, err := l.getJSON(ctx, store, "/loki/api/v1/index/stats", params)
	if err != nil {
		return Volume{}, err
	}
	var v Volume
	if err := json.Unmarshal(body, &v); err != nil {
		return Volume{}, fmt.Errorf("log store: unreadable answer: %w", err)
	}
	return v, nil
}

// Estimate adds the cluster and namespace matchers to req.Query as Query does and asks the store's index for the volume
// of each of its stream selectors over [req.Start, req.End], summed. The query as it would be sent comes back with it.
func (s *Searcher) Estimate(ctx context.Context, req QueryRequest) (Volume, string, error) {
	store, value, ok := s.resolve(ctx, req.Cluster)
	if !ok {
		return Volume{}, "", ErrNotConfigured
	}
	effective, err := InjectMatchers(req.Query, s.scope(value, req.Namespace, req.HiddenNamespace))
	if err != nil {
		return Volume{}, "", err
	}
	selectors, err := Selectors(effective)
	if err != nil {
		return Volume{}, effective, err
	}
	if len(selectors) > MaxEstimatedSelectors {
		return Volume{}, effective, fmt.Errorf("%w: the volume of more than %d stream selectors is not estimated", ErrInvalidLogQL, MaxEstimatedSelectors)
	}
	var total Volume
	for _, sel := range selectors {
		v, err := s.store.indexStats(ctx, store, sel, req.Start, req.End)
		if err != nil {
			return total, effective, err
		}
		total.Streams += v.Streams
		total.Chunks += v.Chunks
		total.Entries += v.Entries
		total.Bytes += v.Bytes
	}
	return total, effective, nil
}

// Size writes a byte count as people read it.
func Size(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit && exp < 4; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTP"[exp])
}

// PatternSeries is one pattern with its samples: [unix seconds, lines] per bucket, as the store gave them.
type PatternSeries struct {
	Pattern string
	Level   string
	Samples [][2]int64
}

// PatternSamples runs req.Query (a stream selector) on the store's pattern ingester with the cluster and namespace
// matchers added, keeping each pattern's samples so the caller can split them by time. The query actually sent comes
// back with them.
func (s *Searcher) PatternSamples(ctx context.Context, req QueryRequest) ([]PatternSeries, string, error) {
	store, value, ok := s.resolve(ctx, req.Cluster)
	if !ok {
		return nil, "", ErrNotConfigured
	}
	effective, err := InjectMatchers(req.Query, s.scope(value, req.Namespace, req.HiddenNamespace))
	if err != nil {
		return nil, "", err
	}
	data, err := s.store.patternData(ctx, store, effective, req.Start, req.End)
	if err != nil {
		return nil, effective, err
	}
	out := make([]PatternSeries, 0, len(data))
	for _, d := range data {
		p := PatternSeries{Pattern: d.Pattern, Level: d.Level}
		if r := []rune(p.Pattern); len(r) > maxPatternText {
			p.Pattern = string(r[:maxPatternText]) + "…"
		}
		for _, smp := range d.Samples {
			ts, err1 := smp[0].Int64()
			n, err2 := smp[1].Int64()
			if err1 != nil || err2 != nil {
				continue
			}
			p.Samples = append(p.Samples, [2]int64{ts, n})
		}
		out = append(out, p)
	}
	return out, effective, nil
}
