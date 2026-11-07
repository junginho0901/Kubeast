package helm

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"sigs.k8s.io/yaml"
)

// Without resource.secret.reveal the values are read masked (maskText), and an upgrade replaces them whole, so saving that
// text would store the placeholder's letters. A placeholder left where it was shown stands for the value it hides, which
// stays: refusing it instead would leave such an editor no way to change anything in a release with one password. Elsewhere
// it stands for nothing and the upgrade is refused. A value kept this way is one the caller cannot read, so it stays out of
// what comes back too.

// maskMark starts every placeholder services/pkg/redact writes.
const maskMark = "<REDACTED:"

// ErrMaskedValues is an upgrade holding a placeholder where it stands for no value. Its text names places, not values.
var ErrMaskedValues = errors.New("the values hold a masked placeholder where it stands for no value")

type keptValues struct {
	places  []string
	changed []string
	refused []string
	texts   []string
	differs bool
}

// keepMaskedValues gives sent with each placeholder replaced by what it hides in current.
func keepMaskedValues(sent, current map[string]interface{}) (map[string]interface{}, *keptValues) {
	kept := &keptValues{}
	shown := shownValues(current)
	out, _ := kept.walk("", "", sent, shown, current, true).(map[string]interface{})
	kept.changed = kept.notKept(maskPlaces("", shown))
	kept.differs = valuesDiffer(sent, shown)
	return out, kept
}

// notKept is places without those kept: a placeholder shown and not kept was written over or removed, which a masked diff
// cannot show. This reads what was shown and sent and never the value, so it confirms no guess.
func (k *keptValues) notKept(places []string) []string {
	kept := make(map[string]int, len(k.places))
	for _, place := range k.places {
		kept[place]++
	}
	var changed []string
	for _, place := range places {
		if kept[place] > 0 {
			kept[place]--
			continue
		}
		changed = append(changed, place)
	}
	return changed
}

// maskPlaces lists where shown holds a placeholder.
func maskPlaces(place string, shown interface{}) []string {
	var places []string
	switch v := shown.(type) {
	case string:
		if strings.Contains(v, maskMark) {
			places = append(places, place)
		}
	case map[string]interface{}:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			places = append(places, maskPlaces(placeOfKey(place, key), v[key])...)
		}
	case []interface{}:
		for i, item := range v {
			places = append(places, maskPlaces(fmt.Sprintf("%s[%d]", place, i), item)...)
		}
	}
	return places
}

func placeOfKey(place, key string) string {
	if place == "" {
		return key
	}
	return place + "." + key
}

// shownValues is current as the caller read it, parsed as the text they send back is.
func shownValues(current map[string]interface{}) map[string]interface{} {
	return parsedValues(current, maskText)
}

// plainValues is shownValues for a caller who reads the values unmasked.
func plainValues(current map[string]interface{}) map[string]interface{} {
	return parsedValues(current, func(text string) string { return text })
}

func parsedValues(current map[string]interface{}, read func(string) string) map[string]interface{} {
	text, err := marshalValues(current)
	if err != nil {
		return nil
	}
	var parsed map[string]interface{}
	if yaml.Unmarshal([]byte(read(text)), &parsed) != nil {
		return nil
	}
	return parsed
}

// valuesDiffer says whether what was sent differs from what the caller read. No diff may show that (a value only a Secret
// holds, only a hook uses or nothing uses). read is the caller's own view, so this says nothing about a value hidden from them.
func valuesDiffer(sent, read map[string]interface{}) bool {
	if len(sent) == 0 && len(read) == 0 {
		return false
	}
	return !reflect.DeepEqual(sent, read)
}

// walk keeps what the placeholders in sent stand for. place is where sent has a thing, for a refusal; shownPlace is where
// it was shown, which the caller read and a list edit may have moved it from.
func (k *keptValues) walk(place, shownPlace string, sent, shown, real interface{}, hasReal bool) interface{} {
	switch v := sent.(type) {
	case string:
		if !strings.Contains(v, maskMark) {
			return v
		}
		if text, ok := shown.(string); ok && text == v && hasReal {
			k.places = append(k.places, shownPlace)
			k.addTexts(real)
			return real
		}
		k.refused = append(k.refused, place)
	case map[string]interface{}:
		shownMap, _ := shown.(map[string]interface{})
		realMap, _ := real.(map[string]interface{})
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := make(map[string]interface{}, len(v))
		for _, key := range keys {
			inner := placeOfKey(place, key)
			if strings.Contains(key, maskMark) {
				k.refused = append(k.refused, inner)
				continue
			}
			value, there := realMap[key]
			out[key] = k.walk(inner, placeOfKey(shownPlace, key), v[key], shownMap[key], value, there)
		}
		return out
	case []interface{}:
		shownList, _ := shown.([]interface{})
		realList, _ := real.([]interface{})
		from := matchItems(v, shownList)
		out := make([]interface{}, len(v))
		for i, item := range v {
			var shownItem, realItem interface{}
			hasItem := from[i] >= 0 && from[i] < len(realList)
			if hasItem {
				shownItem, realItem = shownList[from[i]], realList[from[i]]
			}
			out[i] = k.walk(fmt.Sprintf("%s[%d]", place, i), fmt.Sprintf("%s[%d]", shownPlace, from[i]), item, shownItem, realItem, hasItem)
		}
		return out
	}
	return sent
}

// matchItems says which shown item each sent item holding a placeholder stands for, or -1. An item goes with the item shown
// with the same text, wherever it stands, so its value goes with it. Items of one text cannot be told apart, so they match
// only while all of them stay, in order; otherwise which value is meant cannot be said. Only text decides, so a refusal does
// not say whether the hidden values are the same. One item left over, standing where a shown item is left over, had another
// field edited: walk still holds its placeholders to that item's. More than one could be a swap, so they are refused.
func matchItems(sent, shown []interface{}) []int {
	shownAt := make(map[string][]int, len(shown))
	for i, item := range shown {
		text := itemText(item)
		shownAt[text] = append(shownAt[text], i)
	}
	from := make([]int, len(sent))
	sentAt := make(map[string][]int, len(sent))
	for i, item := range sent {
		from[i] = -1
		if holdsMask(item) {
			text := itemText(item)
			sentAt[text] = append(sentAt[text], i)
		}
	}
	matched := make(map[int]bool, len(shown))
	var leftOver []int
	for text, at := range sentAt {
		there := shownAt[text]
		switch len(there) {
		case 0:
			leftOver = append(leftOver, at...)
		case len(at):
			for n, i := range at {
				from[i] = there[n]
				matched[there[n]] = true
			}
		}
	}
	if len(leftOver) == 1 && len(sent) == len(shown) && !matched[leftOver[0]] {
		from[leftOver[0]] = leftOver[0]
	}
	return from
}

func itemText(item interface{}) string {
	return fmt.Sprintf("%#v", item)
}

func holdsMask(v interface{}) bool {
	switch value := v.(type) {
	case string:
		return strings.Contains(value, maskMark)
	case map[string]interface{}:
		for key, inner := range value {
			if strings.Contains(key, maskMark) || holdsMask(inner) {
				return true
			}
		}
	case []interface{}:
		for _, inner := range value {
			if holdsMask(inner) {
				return true
			}
		}
	}
	return false
}

// addTexts lists how a kept value can read in an error: as a whole, line by line and, for a number, as templates print it.
func (k *keptValues) addTexts(v interface{}) {
	switch value := v.(type) {
	case string:
		if value != "" {
			k.texts = append(k.texts, value)
		}
		for _, line := range strings.Split(value, "\n") {
			if line = strings.TrimSpace(line); line != "" && line != value {
				k.texts = append(k.texts, line)
			}
		}
	case float64:
		k.texts = append(k.texts, strconv.FormatFloat(value, 'f', -1, 64), strconv.FormatFloat(value, 'g', -1, 64), fmt.Sprint(value))
	case int64:
		k.texts = append(k.texts, strconv.FormatInt(value, 10))
	case map[string]interface{}:
		for _, inner := range value {
			k.addTexts(inner)
		}
	case []interface{}:
		for _, inner := range value {
			k.addTexts(inner)
		}
	}
}

// refusal says where a placeholder stands for no value; nil without one.
func (k *keptValues) refusal() error {
	if len(k.refused) == 0 {
		return nil
	}
	return fmt.Errorf("%w (%s): write the value there, or put the line back as it was shown", ErrMaskedValues, strings.Join(k.refused, ", "))
}

// scrubbedError is an error with the kept values out of its text, still what it wraps for errors.Is.
type scrubbedError struct {
	text string
	err  error
}

func (e *scrubbedError) Error() string { return e.text }
func (e *scrubbedError) Unwrap() error { return e.err }

// scrub takes the kept values out of an error: a chart's schema or a template's fail can quote what it was given, and a
// caller who cannot read those values sent none of them.
func (k *keptValues) scrub(err error) error {
	if err == nil || len(k.texts) == 0 {
		return err
	}
	longestFirst := append([]string{}, k.texts...)
	sort.SliceStable(longestFirst, func(i, j int) bool { return len(longestFirst[i]) > len(longestFirst[j]) })
	msg := err.Error()
	for _, text := range longestFirst {
		quoted := strconv.Quote(text)
		quoted = quoted[1 : len(quoted)-1]
		// as is, as Go and the API server quote it, and as the chart schema's validator does
		for _, form := range []string{text, quoted, strings.ReplaceAll(strings.ReplaceAll(quoted, `\"`, `"`), `'`, `\'`)} {
			msg = strings.ReplaceAll(msg, form, "***")
		}
	}
	if msg == err.Error() {
		return err
	}
	return &scrubbedError{text: msg, err: err}
}
