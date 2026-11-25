// k8s_get_resource_yaml's answer with AI_YAML_SPEC_FIRST (chart ai.yamlSpecFirst, off by default). kubectl prints an
// object's keys by name, so an object kubectl apply made starts with the last-applied-configuration annotation, a copy of
// older values, and what the model reads of a long one (its first 6,000 characters unless its config says another) ends
// before the spec. With the switch the spec (data, rules …) comes first, then the metadata without managedFields and
// without that annotation, then the status, and the last line says what differs from what was last applied. Off, and for
// every answer that names a Secret, the answer is kubectl's text as it was.

package main

import (
	"reflect"
	"regexp"
	"strings"

	utilyaml "k8s.io/apimachinery/pkg/util/yaml"

	"github.com/junginho0901/kubeast/services/pkg/config"
	"github.com/junginho0901/kubeast/services/pkg/redact"
)

// yamlSpecFirst is AI_YAML_SPEC_FIRST by the one switch rule (config.SwitchOn), read at each answer.
func yamlSpecFirst() bool { return config.EnvSwitch("AI_YAML_SPEC_FIRST") }

// yamlShapeMaxBytes: a longer answer stays as kubectl printed it. The decoded object is the memory, and an answer past
// bigAnswerBytes has places of its own to wait for.
const yamlShapeMaxBytes = bigAnswerBytes

// yamlBlock is one top-level key of kubectl's YAML with the lines under it.
type yamlBlock struct{ key, text string }

// reTopLevelKey is the line a top-level key starts with, as kubectl prints it.
var reTopLevelKey = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_.\-]*):(?:[ \r\n]|$)`)

// specFirst is kubectl's YAML of one object with its spec first, or the text as it came: of a Secret, of a list, of what
// was cut, and of anything that does not read as one object printed by kubectl.
func specFirst(out, resourceType string) string {
	if len(out) > yamlShapeMaxBytes || outputCut(out) || namesSecrets(resourceType) {
		return out
	}
	// a Secret anywhere in the text (a manifest inside a ConfigMap): its masking goes by the text as kubectl prints it
	if _, secret := redact.Text(out, redact.Options{}); secret.Count > 0 || strings.Contains(out, "kind: Secret") {
		return out
	}
	warnings, text := kubectlWarnings(out)
	var object map[string]interface{}
	if utilyaml.Unmarshal([]byte(text), &object) != nil {
		return out
	}
	metadata, _ := object["metadata"].(map[string]interface{})
	if kind, _ := object["kind"].(string); kind == "" || metadata["name"] == nil {
		return out
	}
	blocks, ok := topLevelBlocks(text)
	if !ok || len(blocks) != len(object) {
		return out
	}
	byKey := map[string]string{}
	for _, b := range blocks {
		if _, known := object[b.key]; !known {
			return out
		}
		byKey[b.key] = b.text
	}
	if len(byKey) != len(object) {
		return out
	}
	trimmed, ok := trimmedMetadata(byKey["metadata"], metadata)
	if !ok {
		return out
	}
	var b strings.Builder
	b.WriteString(warnings)
	b.WriteString(byKey["apiVersion"] + byKey["kind"])
	for _, block := range blocks {
		switch block.key {
		case "apiVersion", "kind", "metadata", "status":
		default:
			b.WriteString(block.text)
		}
	}
	b.WriteString(trimmed + byKey["status"])
	if line := differsFromLastApplied(object); line != "" {
		b.WriteString(line + "\n")
	}
	return b.String()
}

// kubectlWarnings splits off the warning lines kubectl prints before the object.
func kubectlWarnings(out string) (warnings, text string) {
	text = out
	for strings.HasPrefix(text, "Warning: ") {
		end := strings.IndexByte(text, '\n')
		if end < 0 {
			break
		}
		text = text[end+1:]
	}
	return out[:len(out)-len(text)], text
}

// topLevelBlocks splits the YAML at its top-level keys; ok is false for text that is not laid out as kubectl prints it.
func topLevelBlocks(text string) (blocks []yamlBlock, ok bool) {
	for _, line := range strings.SplitAfter(text, "\n") {
		if line == "" {
			continue
		}
		if m := reTopLevelKey.FindStringSubmatch(line); m != nil {
			blocks = append(blocks, yamlBlock{key: m[1]})
		} else if len(blocks) == 0 || !(line[0] == ' ' || line == "\n" || line == "-\n" || strings.HasPrefix(line, "- ")) {
			return nil, false
		}
		if !strings.HasSuffix(line, "\n") {
			line += "\n"
		}
		blocks[len(blocks)-1].text += line
	}
	return blocks, len(blocks) > 0
}

// trimmedMetadata is the metadata's lines without managedFields and the last-applied annotation (and without annotations
// when it was the only one). ok is false when what is left does not read as the metadata without those two.
func trimmedMetadata(text string, metadata map[string]interface{}) (string, bool) {
	want := map[string]interface{}{}
	for k, v := range metadata {
		want[k] = v
	}
	delete(want, "managedFields")
	noAnnotations := false
	if annotations, isMap := metadata["annotations"].(map[string]interface{}); isMap && annotations[lastAppliedAnnotation] != nil {
		kept := map[string]interface{}{}
		for k, v := range annotations {
			if k != lastAppliedAnnotation {
				kept[k] = v
			}
		}
		want["annotations"] = kept
		if noAnnotations = len(kept) == 0; noAnnotations {
			delete(want, "annotations")
		}
	}
	var b strings.Builder
	section, dropped := "", false // the metadata key the line is under; the line is under a key that goes
	for _, line := range strings.SplitAfter(text, "\n") {
		body := strings.TrimLeft(line, " ")
		indent := len(line) - len(body)
		if strings.TrimSpace(body) != "" {
			switch {
			case indent == 2 && !strings.HasPrefix(body, "- "):
				section, _, _ = strings.Cut(body, ":")
				dropped = section == "managedFields" || section == "annotations" && noAnnotations
			case indent == 4 && section == "annotations" && !noAnnotations:
				dropped = strings.HasPrefix(body, lastAppliedAnnotation+":")
			}
		}
		if !dropped {
			b.WriteString(line)
		}
	}
	var left map[string]interface{}
	if utilyaml.Unmarshal([]byte(b.String()), &left) != nil || !reflect.DeepEqual(left["metadata"], interface{}(want)) {
		return "", false
	}
	return b.String(), true
}
