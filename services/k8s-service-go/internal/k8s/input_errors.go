package k8s

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// ErrBadInput marks a fault in what the caller sent — YAML that does not read as objects, a field it left out, a kind
// the cluster does not serve — which is a 400 with the reason, as kubectl refuses it before the API server, never a
// server error. Its words name the caller's own text, so the handler maps it by type, not by what the words hold.
var ErrBadInput = errors.New("bad input")

type inputError struct{ msg string }

func (e inputError) Error() string        { return e.msg }
func (e inputError) Is(target error) bool { return target == ErrBadInput }

func badInput(format string, a ...interface{}) error {
	return inputError{msg: fmt.Sprintf(format, a...)}
}

var yamlTypeLine = regexp.MustCompile(`line (\d+): cannot unmarshal (!!\w+)`)

// yamlReadError says why a YAML document could not be read as an object: where the text breaks YAML, in the parser's
// words without its "yaml: " prefix, or what the document is instead of an object — never the value itself, which the
// parser quotes cut at a byte count (half a Korean letter).
func yamlReadError(doc int, err error) error {
	var typeErr *yaml.TypeError
	if errors.As(err, &typeErr) {
		for _, e := range typeErr.Errors {
			if m := yamlTypeLine.FindStringSubmatch(e); m != nil {
				return badInput("document %d (line %s) is %s, not an object with apiVersion, kind and metadata", doc, m[1], yamlNodeWord(m[2]))
			}
		}
		return badInput("document %d is not an object with apiVersion, kind and metadata", doc)
	}
	return badInput("document %d is not YAML: %s", doc, strings.TrimPrefix(err.Error(), "yaml: "))
}

func yamlNodeWord(tag string) string {
	switch tag {
	case "!!str":
		return "text"
	case "!!seq":
		return "a list"
	case "!!int", "!!float", "!!bool", "!!null", "!!timestamp", "!!binary":
		return "a single value"
	}
	return "not a mapping"
}

// editedObject reads a YAML window's text as the one object an apply sends: text that does not read, an emptied
// window and a value that is not a mapping are the caller's to fix.
func editedObject(yamlStr string) (map[string]interface{}, error) {
	var parsed interface{}
	if err := yaml.Unmarshal([]byte(yamlStr), &parsed); err != nil {
		return nil, badInput("the YAML does not read: %s", strings.TrimPrefix(err.Error(), "yaml: "))
	}
	object, isObject := parsed.(map[string]interface{})
	if parsed == nil || (isObject && len(object) == 0) {
		return nil, badInput("the YAML is empty: there is nothing to apply")
	}
	if !isObject {
		return nil, badInput("the YAML is %s, not an object with apiVersion, kind and metadata", yamlValueWord(parsed))
	}
	return object, nil
}

// yamlValueWord says what a whole YAML text read as when it is not a mapping.
func yamlValueWord(v interface{}) string {
	switch v.(type) {
	case string:
		return "text"
	case []interface{}:
		return "a list"
	case map[interface{}]interface{}:
		return "a mapping whose keys are not all text"
	}
	return "a single value"
}

// nestedString is the string at path in a decoded object, "" where it is missing or not a string.
func nestedString(object map[string]interface{}, path ...string) string {
	var cur interface{} = object
	for _, key := range path {
		m, ok := cur.(map[string]interface{})
		if !ok {
			return ""
		}
		cur = m[key]
	}
	s, _ := cur.(string)
	return s
}

// missingTypeFields names what kubectl's validation names when a document leaves apiVersion or kind out.
func missingTypeFields(apiVersion, kind string) string {
	var missing []string
	if apiVersion == "" {
		missing = append(missing, "apiVersion not set")
	}
	if kind == "" {
		missing = append(missing, "kind not set")
	}
	return strings.Join(missing, ", ")
}
