package helm

import (
	"errors"
	"fmt"
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
	refused []string
	texts   []string
}

// keepMaskedValues gives sent with each placeholder replaced by what it hides in current.
func keepMaskedValues(sent, current map[string]interface{}) (map[string]interface{}, *keptValues) {
	kept := &keptValues{}
	out, _ := kept.walk("", sent, shownValues(current), current, true).(map[string]interface{})
	return out, kept
}

// shownValues is current as the caller read it, parsed as the text they send back is.
func shownValues(current map[string]interface{}) map[string]interface{} {
	text, err := marshalValues(current)
	if err != nil {
		return nil
	}
	var shown map[string]interface{}
	if yaml.Unmarshal([]byte(maskText(text)), &shown) != nil {
		return nil
	}
	return shown
}

func (k *keptValues) walk(place string, sent, shown, real interface{}, hasReal bool) interface{} {
	switch v := sent.(type) {
	case string:
		if !strings.Contains(v, maskMark) {
			return v
		}
		if text, ok := shown.(string); ok && text == v && hasReal {
			k.places = append(k.places, place)
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
			inner := key
			if place != "" {
				inner = place + "." + key
			}
			if strings.Contains(key, maskMark) {
				k.refused = append(k.refused, inner)
				continue
			}
			value, there := realMap[key]
			out[key] = k.walk(inner, v[key], shownMap[key], value, there)
		}
		return out
	case []interface{}:
		shownList, _ := shown.([]interface{})
		realList, _ := real.([]interface{})
		out := make([]interface{}, len(v))
		for i, item := range v {
			var shownItem, realItem interface{}
			if i < len(shownList) {
				shownItem = shownList[i]
			}
			if i < len(realList) {
				realItem = realList[i]
			}
			out[i] = k.walk(fmt.Sprintf("%s[%d]", place, i), item, shownItem, realItem, i < len(realList))
		}
		return out
	}
	return sent
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
