// Package promote moves a service's images from one environment to the
// next (design ⓑ §8-1): the image of each container in the earlier
// environment's values file is written into the next one's, as a commit on
// the branch or on a new branch for a pull request.
//
// The file is edited in place, as Kargo's yaml-update step does: only the
// image values change and the rest of the file — order, comments, quoting,
// spacing — stays byte for byte, including a comment after the image on its
// line (Kargo's SetValuesInBytes drops the rest of that line). Unlike that
// step, a missing file or key is created, so the first promotion to an
// environment works; the file is then written back whole, which keeps its
// comments but evens the spacing before end-of-line comments.
package promote

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Path is a service's values file for an environment.
func Path(service, env string) string {
	return "environments/" + env + "/" + service + ".score.yaml"
}

var imageRe = regexp.MustCompile(`^[^\s@:]+(:[^\s@:]+)?(@sha256:[0-9a-f]{64})?$`)

// Images reads the image of each container in an environment's values
// file: containers.<name>.image.
func Images(file []byte) (map[string]string, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(file, &doc); err != nil {
		return nil, err
	}
	out := map[string]string{}
	containers := lookup(root(&doc), "containers")
	if containers == nil {
		return out, nil
	}
	if containers.Kind != yaml.MappingNode {
		return nil, errors.New("containers is not a map")
	}
	for i := 0; i+1 < len(containers.Content); i += 2 {
		name, c := containers.Content[i].Value, containers.Content[i+1]
		img := lookup(c, "image")
		if img == nil {
			continue
		}
		if img.Kind != yaml.ScalarNode || !imageRe.MatchString(img.Value) || img.Value == "." {
			return nil, fmt.Errorf("container %s: image %q is not an image reference", name, img.Value)
		}
		out[name] = img.Value
	}
	return out, nil
}

// Apply writes images into an environment's values file (nil or empty:
// a new file) and reports which containers changed. A file that already
// has every image comes back unchanged.
func Apply(file []byte, images map[string]string) ([]byte, []string, error) {
	if len(images) == 0 {
		return nil, nil, errors.New("no images to promote")
	}
	for name, img := range images {
		if !imageRe.MatchString(img) || img == "." {
			return nil, nil, fmt.Errorf("container %s: image %q is not an image reference", name, img)
		}
	}
	var doc yaml.Node
	if len(bytes.TrimSpace(file)) > 0 {
		if err := yaml.Unmarshal(file, &doc); err != nil {
			return nil, nil, err
		}
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	top := root(&doc)
	if top.Kind != yaml.MappingNode {
		return nil, nil, errors.New("the values file is not a map")
	}
	containers := ensureMap(top, "containers")
	if containers == nil {
		return nil, nil, errors.New("containers is not a map")
	}
	names := make([]string, 0, len(images))
	for name := range images {
		names = append(names, name)
	}
	sort.Strings(names)
	if out, changed, ok, err := inPlace(file, top, names, images); ok || err != nil {
		return out, changed, err
	}
	var changed []string
	for _, name := range names {
		c := ensureMap(containers, name)
		if c == nil {
			return nil, nil, fmt.Errorf("container %s is not a map", name)
		}
		img := lookup(c, "image")
		switch {
		case img == nil:
			c.Content = append(c.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: "image"}, &yaml.Node{Kind: yaml.ScalarNode, Value: images[name]})
		case img.Kind != yaml.ScalarNode:
			return nil, nil, fmt.Errorf("container %s: image is not a value", name)
		case img.Value == images[name]:
			continue
		default:
			img.Value = images[name]
		}
		changed = append(changed, name)
	}
	if len(changed) == 0 {
		return file, nil, nil
	}
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(indent(file))
	if err := enc.Encode(&doc); err != nil {
		return nil, nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, nil, err
	}
	return out.Bytes(), changed, nil
}

// inPlace replaces the image values in the file's own bytes when every
// container and image key is already there (ok false otherwise).
func inPlace(file []byte, top *yaml.Node, names []string, images map[string]string) ([]byte, []string, bool, error) {
	type edit struct {
		line, col int // 0-based line, byte column
		end       int // byte column after the token
		value     string
	}
	lines := strings.SplitAfter(string(file), "\n")
	var edits []edit
	var changed []string
	containers := lookup(top, "containers")
	for _, name := range names {
		img := lookup(lookup(containers, name), "image")
		if img == nil {
			return nil, nil, false, nil
		}
		if img.Kind != yaml.ScalarNode {
			return nil, nil, false, fmt.Errorf("container %s: image is not a value", name)
		}
		if img.Value == images[name] {
			continue
		}
		if img.Line-1 >= len(lines) { // a block scalar fails in tokenEnd
			return nil, nil, false, fmt.Errorf("container %s: image must be a one-line value", name)
		}
		line := lines[img.Line-1]
		col := byteColumn(line, img.Column-1)
		end, err := tokenEnd(line, col, img)
		if err != nil {
			return nil, nil, false, fmt.Errorf("container %s: %w", name, err)
		}
		v := images[name]
		switch {
		case img.Style&yaml.DoubleQuotedStyle != 0:
			v = `"` + v + `"`
		case img.Style&yaml.SingleQuotedStyle != 0:
			v = "'" + v + "'"
		}
		edits = append(edits, edit{line: img.Line - 1, col: col, end: end, value: v})
		changed = append(changed, name)
	}
	if len(changed) == 0 {
		return file, nil, true, nil
	}
	// Right to left, so earlier columns on a line stay where they are.
	sort.Slice(edits, func(i, j int) bool {
		if edits[i].line != edits[j].line {
			return edits[i].line < edits[j].line
		}
		return edits[i].col > edits[j].col
	})
	for _, e := range edits {
		l := lines[e.line]
		lines[e.line] = l[:e.col] + e.value + l[e.end:]
	}
	return []byte(strings.Join(lines, "")), changed, true, nil
}

// byteColumn turns yaml's character column into a byte offset in line.
func byteColumn(line string, chars int) int {
	n := 0
	for i := range line {
		if n == chars {
			return i
		}
		n++
	}
	return len(line)
}

// tokenEnd is the byte after a one-line scalar that starts at col.
func tokenEnd(line string, col int, n *yaml.Node) (int, error) {
	switch {
	case n.Style&yaml.DoubleQuotedStyle != 0:
		for i := col + 1; i < len(line); i++ {
			switch line[i] {
			case '\\':
				i++
			case '"':
				return i + 1, nil
			}
		}
	case n.Style&yaml.SingleQuotedStyle != 0:
		for i := col + 1; i < len(line); i++ {
			if line[i] == '\'' {
				if i+1 < len(line) && line[i+1] == '\'' {
					i++
					continue
				}
				return i + 1, nil
			}
		}
	default:
		if end := col + len(n.Value); end <= len(line) && line[col:end] == n.Value {
			return end, nil
		}
	}
	return 0, errors.New("image must be a one-line value")
}

func root(doc *yaml.Node) *yaml.Node {
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		return doc.Content[0]
	}
	return doc
}

func lookup(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// ensureMap returns m[key], adding an empty map there if it is missing;
// nil when it is there but not a map.
func ensureMap(m *yaml.Node, key string) *yaml.Node {
	if v := lookup(m, key); v != nil {
		if v.Kind != yaml.MappingNode {
			return nil
		}
		return v
	}
	v := &yaml.Node{Kind: yaml.MappingNode}
	m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, v)
	return v
}

// indent is the file's own indentation (the first indented line), 2 if it
// has none.
func indent(file []byte) int {
	for _, line := range strings.Split(string(file), "\n") {
		trimmed := strings.TrimLeft(line, " ")
		if n := len(line) - len(trimmed); n > 0 && trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			return n
		}
	}
	return 2
}
