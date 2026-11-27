package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/runtime"
	utiljson "k8s.io/apimachinery/pkg/util/json"

	"github.com/junginho0901/kubeast/services/pkg/redact"
)

const (
	lastAppliedAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

	// differsLead starts the line; ai-service keeps the line when it cuts the YAML above it (formatters.YAML_DIFFERS).
	differsLead      = "# differs from last-applied: "
	differsLineChars = 900
	differsValue     = 60
	// how much of what two long values have in common is shown in front of where they part
	differsBefore = 15
)

// differsFromLastApplied is the line that says which fields kubectl apply last set hold another value now, or are gone,
// and which entries of a list or of a map of plain values were added to them; "" of an object without the annotation. A
// field apply did not set is not compared, since the API server fills those in. It reads the object as kubectl printed
// it, with its values masked as an answer's are before they are written.
func differsFromLastApplied(object map[string]interface{}) string {
	metadata, _ := object["metadata"].(map[string]interface{})
	annotations, _ := metadata["annotations"].(map[string]interface{})
	text, _ := annotations[lastAppliedAnnotation].(string)
	if text == "" {
		return ""
	}
	var applied map[string]interface{}
	if utiljson.Unmarshal([]byte(text), &applied) != nil || applied == nil {
		return differsLead + "not compared, the annotation does not read as JSON"
	}
	if applied["apiVersion"] != object["apiVersion"] || applied["kind"] != object["kind"] {
		return differsLead + fmt.Sprintf("not compared, it was applied as %s %s", plain(applied["apiVersion"]), plain(applied["kind"]))
	}
	d := &appliedDiffer{pod: object["kind"] == "Pod", job: object["kind"] == "Job"}
	d.walk("", "", "", sides{applied, object, masked(applied), masked(object)})
	if len(d.found) == 0 {
		return differsLead + "nothing (of the fields it set)"
	}
	line, left := differsLead, 0
	for i, f := range d.found {
		if i > 0 && utf8.RuneCountInString(line)+utf8.RuneCountInString(f) > differsLineChars {
			left = len(d.found) - i
			break
		}
		if i > 0 {
			line += "; "
		}
		line += f
	}
	if left > 0 {
		line += fmt.Sprintf("; and %d more", left)
	}
	return line
}

// masked is a copy with its credentials masked. Personal data is left to the answer's own masking, which numbers it.
func masked(v map[string]interface{}) interface{} {
	opts := redactOpts
	opts.PII = false
	out, _ := redact.Object(runtime.DeepCopyJSON(v), opts)
	return out
}

// sides are one field as it was applied and as it is now, read and masked.
type sides struct{ was, is, maskedWas, maskedIs interface{} }

type appliedDiffer struct {
	pod, job bool
	found    []string
}

// notCompared: what the API server or a controller writes.
var notCompared = map[string]bool{
	"apiVersion": true, "kind": true, "status": true, "metadata.creationTimestamp": true, "metadata.generation": true, "metadata.uid": true,
	"metadata.resourceVersion": true, "metadata.managedFields": true, "metadata.finalizers": true, "metadata.ownerReferences": true,
}

// openMaps hold a key per entry that nothing fills in, so a key that was not applied was added. The object's own labels
// and annotations are not such maps (controllers write there), a pod template's are.
var openMaps = map[string]bool{
	"data": true, "binaryData": true, "matchLabels": true, "nodeSelector": true, "selector": true, "limits": true, "requests": true, "hard": true,
	"labels": true, "annotations": true,
}

// openLists are a pod template's lists nothing fills in (a Pod's own are, by admission).
var openLists = map[string]bool{"env": true, "envFrom": true, "args": true, "command": true, "initContainers": true, "volumes": true, "volumeMounts": true}

// quantityKeys and quantityMaps hold amounts the API server writes in its own form (1000m is 1).
var (
	quantityKeys = map[string]bool{"cpu": true, "memory": true, "storage": true, "ephemeral-storage": true, "sizeLimit": true, "divisor": true, "averageValue": true}
	quantityMaps = map[string]bool{"limits": true, "requests": true, "hard": true, "capacity": true, "max": true, "min": true, "default": true, "defaultRequest": true}
)

func (d *appliedDiffer) walk(path, key, parent string, s sides) {
	if notCompared[path] || s.was == nil {
		return
	}
	switch was := s.was.(type) {
	case map[string]interface{}:
		if is, ok := s.is.(map[string]interface{}); ok {
			d.maps(path, key, was, is, s)
			return
		}
	case []interface{}:
		if is, ok := s.is.([]interface{}); ok {
			d.lists(path, was, is, s)
			return
		}
	}
	if !sameScalar(s.was, s.is, key, parent) {
		d.add(path, s)
	}
}

func (d *appliedDiffer) maps(path, key string, was, is map[string]interface{}, s sides) {
	mw, _ := s.maskedWas.(map[string]interface{})
	mi, _ := s.maskedIs.(map[string]interface{})
	names := make([]string, 0, len(was))
	for k := range was {
		names = append(names, k)
	}
	// metadata, the object's and a pod template's, comes after what it is of
	sort.Slice(names, func(i, j int) bool {
		if (names[i] == "metadata") != (names[j] == "metadata") {
			return names[j] == "metadata"
		}
		return names[i] < names[j]
	})
	for _, k := range names {
		at := fieldPath(path, k)
		if _, there := is[k]; !there {
			if !isEmpty(was[k]) && !notCompared[at] {
				d.add(at, sides{was[k], nil, mw[k], nil})
			}
			continue
		}
		d.walk(at, k, key, sides{was[k], is[k], mw[k], mi[k]})
	}
	var added []string
	for k := range is {
		if was[k] == nil {
			added = append(added, k)
		}
	}
	sort.Strings(added)
	for _, k := range added {
		at := fieldPath(path, k)
		switch v := is[k].(type) {
		case map[string]interface{}:
			inner, _ := mi[k].(map[string]interface{})
			if d.open(at, k) {
				d.added(at, v, inner)
			}
		case []interface{}:
			if openLists[k] && !d.pod && len(v) > 0 {
				d.add(at, sides{nil, v, nil, mi[k]})
			}
		}
	}
	if d.open(path, key) {
		entries := map[string]interface{}{}
		for _, k := range added {
			entries[k] = is[k]
		}
		d.added(path, entries, mi)
	}
}

// open says whether a map holds only what was applied: nothing fills it in.
func (d *appliedDiffer) open(path, key string) bool {
	if !openMaps[key] || path == "metadata.labels" || path == "metadata.annotations" {
		return false
	}
	return !d.job || key != "labels" // the Job controller labels its pod template
}

// added puts the entries of a map of plain values on the line.
func (d *appliedDiffer) added(path string, entries, maskedEntries map[string]interface{}) {
	if !plainValues(entries) {
		return
	}
	names := make([]string, 0, len(entries))
	for k := range entries {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		d.add(fieldPath(path, k), sides{nil, entries[k], nil, maskedEntries[k]})
	}
}

func (d *appliedDiffer) lists(path string, was, is []interface{}, s sides) {
	mw, _ := s.maskedWas.([]interface{})
	mi, _ := s.maskedIs.([]interface{})
	key := listKey(was, is)
	if key == "" {
		if len(was) != len(is) {
			if !reflect.DeepEqual(s.was, s.is) {
				d.add(path, s)
			}
			return
		}
		for i := range was {
			d.walk(fmt.Sprintf("%s[%d]", path, i), "", "", sides{was[i], is[i], nth(mw, i), nth(mi, i)})
		}
		return
	}
	name := func(v interface{}) string { return plain(v.(map[string]interface{})[key]) }
	now := map[string]int{}
	for i, v := range is {
		now[name(v)] = i
	}
	before := map[string]bool{}
	for i, v := range was {
		n := name(v)
		before[n] = true
		at := path + entryName(n)
		if j, there := now[n]; there {
			d.walk(at, "", "", sides{v, is[j], nth(mw, i), nth(mi, j)})
		} else {
			d.add(at, sides{v, nil, nth(mw, i), nil})
		}
	}
	for j, v := range is {
		if n := name(v); !before[n] && !d.pod {
			d.add(path+entryName(n), sides{nil, v, nil, nth(mi, j)})
		}
	}
}

func nth(list []interface{}, i int) interface{} {
	if i >= len(list) {
		return nil
	}
	return list[i]
}

// listKeys: what an entry of a list of objects goes by, the first that every entry has and no two share.
var listKeys = []string{"name", "mountPath", "containerPort", "port", "key", "ip", "host", "type"}

func listKey(lists ...[]interface{}) string {
	for _, key := range listKeys {
		if keyedBy(key, lists...) {
			return key
		}
	}
	return ""
}

func keyedBy(key string, lists ...[]interface{}) bool {
	for _, list := range lists {
		seen := map[string]bool{}
		for _, v := range list {
			m, isMap := v.(map[string]interface{})
			if !isMap || m[key] == nil {
				return false
			}
			n := plain(m[key])
			if n == "" || seen[n] {
				return false
			}
			seen[n] = true
		}
	}
	return true
}

// sameScalar: one value in two forms, or an amount the API server wrote in its own.
func sameScalar(was, is interface{}, key, parent string) bool {
	if reflect.DeepEqual(was, is) || isEmpty(was) && isEmpty(is) {
		return true
	}
	if plainValue(was) && plainValue(is) {
		a, b := plain(was), plain(is)
		if a == b {
			return true
		}
		if parent != "data" && (quantityKeys[key] || quantityMaps[parent]) {
			x, errX := resource.ParseQuantity(a)
			y, errY := resource.ParseQuantity(b)
			return errX == nil && errY == nil && x.Cmp(y) == 0
		}
	}
	return false
}

func plain(v interface{}) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func plainValue(v interface{}) bool {
	switch v.(type) {
	case map[string]interface{}, []interface{}, nil:
		return false
	}
	return true
}

func plainValues(m map[string]interface{}) bool {
	for _, v := range m {
		if !plainValue(v) {
			return false
		}
	}
	return true
}

// isEmpty: a value that leaves nothing in the object it is applied to.
func isEmpty(v interface{}) bool {
	switch t := v.(type) {
	case nil:
		return true
	case map[string]interface{}:
		for _, each := range t {
			if !isEmpty(each) {
				return false
			}
		}
		return true
	case []interface{}:
		return len(t) == 0
	}
	return reflect.ValueOf(v).IsZero()
}

var (
	rePlainKey   = regexp.MustCompile(`^[A-Za-z0-9_\-]{1,100}$`)
	rePlainEntry = regexp.MustCompile(`^[A-Za-z0-9_./:\-]{1,100}$`)
)

// entryName is an entry of a list by its name.
func entryName(n string) string {
	if rePlainEntry.MatchString(n) {
		return "[" + n + "]"
	}
	return "[" + shortName(n) + "]"
}

// shortName is a name that is not one word, or is long, on the line.
func shortName(n string) string {
	if holdsPersonalData(n) {
		return `"…"`
	}
	credentials := redactOpts
	credentials.PII = false
	masked, _ := redact.Text(n, credentials)
	return cutFrom([]rune(jsonText(masked)), 0)
}

func fieldPath(path, key string) string {
	switch {
	case !rePlainKey.MatchString(key):
		return path + "[" + shortName(key) + "]"
	case path == "":
		return key
	}
	return path + "." + key
}

// add puts one difference on the line, its values as the masking leaves them.
func (d *appliedDiffer) add(path string, s sides) {
	switch {
	case reflect.DeepEqual(s.maskedWas, s.maskedIs):
		d.found = append(d.found, path+" (changed, value masked)")
	case holdsPersonalData(s.maskedWas) || holdsPersonalData(s.maskedIs):
		d.found = append(d.found, path+" (changed, personal data not shown)")
	default:
		was, is := valueText(s.maskedWas, s.was == nil), valueText(s.maskedIs, s.is == nil)
		was, is = whereTheyPart(was, is)
		d.found = append(d.found, path+": "+was+" → "+is)
	}
}

// holdsPersonalData: with REDACTION_PII on, a value the masking of the text it is in would change. On the line, as JSON and
// cut short, that masking might no longer see it.
func holdsPersonalData(v interface{}) bool {
	if !redactOpts.PII {
		return false
	}
	switch t := v.(type) {
	case map[string]interface{}:
		for k, each := range t {
			if holdsPersonalData(k) || holdsPersonalData(each) {
				return true
			}
		}
	case []interface{}:
		for _, each := range t {
			if holdsPersonalData(each) {
				return true
			}
		}
	case nil:
	default:
		_, personal := redact.Text(plain(t), redactOpts)
		return personal.Count > 0
	}
	return false
}

func valueText(v interface{}, absent bool) string {
	if absent {
		return "(absent)"
	}
	return jsonText(v)
}

// jsonText is the value on one line.
func jsonText(v interface{}) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if enc.Encode(v) != nil {
		return "?"
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// whereTheyPart cuts two values to differsValue characters each, from a little before the first character they differ in.
func whereTheyPart(a, b string) (string, string) {
	x, y := []rune(a), []rune(b)
	same := 0
	for same < len(x) && same < len(y) && x[same] == y[same] {
		same++
	}
	from := max(0, same-differsBefore)
	if len(x) <= differsValue && len(y) <= differsValue {
		from = 0
	}
	return cutFrom(x, from), cutFrom(y, from)
}

func cutFrom(r []rune, from int) string {
	lead, tail := "", ""
	if from > 0 && from <= len(r) {
		r, lead = r[from:], "…"
	}
	if len(r) > differsValue {
		r, tail = r[:differsValue], "…"
	}
	return lead + string(r) + tail
}
