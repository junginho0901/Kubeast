package k8s

import (
	"context"
	"encoding/json"
	"reflect"
	"time"
	"unicode/utf8"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/flight"
	"github.com/junginho0901/kubeast/services/pkg/accesstrail"
)

// A pods/page or pods/nodes answer of the informer path depends on the rows, the clock, the revision, the caller's access
// decision and the query only, so the callers with the same last three at one moment wait on one build (flight.Group).

// podAnswers are the builds under way of an informer set's pods/page and pods/nodes answers, by podShareKey.
type podAnswers struct{ page, nodes flight.Group[*podAnswer] }

// podAnswer is one build's answer, which everyone who waited on it gets; no one changes it.
type podAnswer struct{ raw []byte }

// podShareKey is all a pods/page or pods/nodes answer depends on besides the rows and the clock.
type podShareKey struct {
	Revision   string   `json:"r"`
	All        bool     `json:"a"`
	Namespaces []string `json:"n"` // as podListAccess gave them, in their order, never a hash of them
	Query      any      `json:"q"`
}

// text is the key as a flight key, its JSON. A key holding a string that is not UTF-8 is not shared: json.Marshal writes
// those bytes as U+FFFD, which another key may hold, and how it writes them differs between Go releases.
func (k podShareKey) text() (string, bool) {
	if !allUTF8(reflect.ValueOf(k)) {
		return "", false
	}
	b, err := json.Marshal(k)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// allUTF8 says whether every string v holds, in its fields, elements, map keys and values and what it points to, is UTF-8.
func allUTF8(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.String:
		return utf8.ValidString(v.String())
	case reflect.Struct:
		for i := range v.NumField() {
			if !allUTF8(v.Field(i)) {
				return false
			}
		}
	case reflect.Slice, reflect.Array:
		for i := range v.Len() {
			if !allUTF8(v.Index(i)) {
				return false
			}
		}
	case reflect.Map:
		for it := v.MapRange(); it.Next(); {
			if !allUTF8(it.Key()) || !allUTF8(it.Value()) {
				return false
			}
		}
	case reflect.Interface, reflect.Pointer:
		if !v.IsNil() {
			return allUTF8(v.Elem())
		}
	}
	return true
}

// podPageShareKey is the key of set's page for q, the selector by the text the handler parsed it from, no caller's revision.
func podPageShareKey(set *podRowSet, q PodPageQuery) podShareKey {
	selector := q.LabelSelector != nil
	q.Revision, q.LabelSelector = "", nil
	return podShareKey{Revision: set.revision, All: set.all, Namespaces: set.namespaces, Query: struct {
		PodPageQuery
		Selector bool
	}{q, selector}}
}

// podNodesShareKey is the key of set's node map for the search q in namespace.
func podNodesShareKey(set *podRowSet, namespace, q string) podShareKey {
	return podShareKey{Revision: set.revision, All: set.all, Namespaces: set.namespaces, Query: struct{ Namespace, Q string }{namespace, q}}
}

// GetPodPageJSON is GetPodPage's answer as response.JSON writes it, the informer path's built once per podShareKey at one moment.
func (s *Service) GetPodPageJSON(ctx context.Context, q PodPageQuery) ([]byte, error) {
	set, err := s.callerPodRows(ctx, q.Namespace, q.Revision, true)
	if err != nil {
		return nil, err
	}
	if set.ci == nil {
		return ownPodAnswer(set, func() any { return podPageOf(set, q, s.podNow()) }), nil
	}
	return s.sharedPodAnswer(ctx, &set.ci.answers.page, podPageShareKey(set, q), set.ci, func(rows []*podRow, rev string, now time.Time) any {
		return podPageFrom(rows, rev, "index", q, now)
	})
}

// GetPodNodeSummaryJSON is GetPodNodeSummary's answer as response.JSON writes it, the informer path's built once per
// podShareKey at one moment.
func (s *Service) GetPodNodeSummaryJSON(ctx context.Context, namespace, q, revision string) ([]byte, error) {
	set, err := s.callerPodRows(ctx, namespace, revision, true)
	if err != nil {
		return nil, err
	}
	if set.ci == nil {
		return ownPodAnswer(set, func() any { return podNodeSummaryOf(set, q) }), nil
	}
	return s.sharedPodAnswer(ctx, &set.ci.answers.nodes, podNodesShareKey(set, namespace, q), set.ci, func(rows []*podRow, rev string, _ time.Time) any {
		return podNodeSummaryFrom(rows, rev, "index", q)
	})
}

// sharedPodAnswer builds the answer of the rows key's decision may see once for the callers with key at one moment,
// holding one podRowSlots place while it has the rows; those who wait for it hold none.
func (s *Service) sharedPodAnswer(ctx context.Context, answers *flight.Group[*podAnswer], key podShareKey, ci *clusterInformers,
	build func(rows []*podRow, rev string, now time.Time) any) ([]byte, error) {
	text, shared := key.text()
	run := func(ctx context.Context) (*podAnswer, error) {
		s.buildStep(text, "place")
		release, err := takePodRowSlot(ctx)
		if err != nil {
			s.buildStep(text, "no place")
			return nil, err
		}
		v := func() any {
			defer release() // before the encoding, as set.done() gave it back
			rows := ci.podRows(key.All, key.Namespaces)
			s.buildStep(text, "rows")
			return build(rows, key.Revision, s.podNow())
		}()
		return &podAnswer{raw: answerBytes(v)}, nil
	}
	var a *podAnswer
	var joined bool
	var err error
	if shared {
		a, joined, err = answers.DoOr(ctx, text, func() (*podAnswer, error) { return run(ctx) }, run)
	} else {
		a, err = run(ctx)
	}
	if err != nil {
		return nil, err
	}
	if joined {
		accesstrail.Cached(ctx, "the same read of another request")
	}
	return a.raw, nil
}

// ownPodAnswer is the answer of a set made for its caller alone, the set's place given back before the encoding.
func ownPodAnswer(set *podRowSet, answer func() any) []byte {
	v := func() any {
		defer set.done()
		return answer()
	}()
	return answerBytes(v)
}

// answerBytes is what response.JSON writes of v: its JSON and a newline, nothing when it cannot be encoded.
func answerBytes(v any) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return append(raw, '\n')
}

// podNow is the clock a pods answer's age sort reads.
func (s *Service) podNow() time.Time {
	if s.podClock != nil {
		return s.podClock()
	}
	return time.Now()
}

func (s *Service) buildStep(key, step string) {
	if s.podBuildStep != nil {
		s.podBuildStep(key, step)
	}
}
