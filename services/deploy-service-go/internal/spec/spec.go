// Package spec reads a Score workload (score.dev/v1b1) and the kubeast.io/*
// annotations on it. Parsing, the schema, overrides and the Go types come from
// score-go, the library score-k8s and score-compose are built on, so a file
// that works with them works here.
package spec

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/santhosh-tekuri/jsonschema/v5"
	"github.com/score-spec/score-go/framework"
	"github.com/score-spec/score-go/loader"
	"github.com/score-spec/score-go/schema"
	"github.com/score-spec/score-go/types"
)

// Input is one workload as one environment sees it.
type Input struct {
	// Score is the workload file (services/<name>/score.yaml).
	Score []byte
	// Overrides are partial Score files merged over it in order, the way
	// score-k8s --overrides-file does (environments/<env>/<name>.score.yaml).
	// Maps merge, other values replace, a null removes the key.
	Overrides [][]byte
	// Files is where a container file's `source` is read from, relative to
	// the Score file. Nil refuses `source`.
	Files fs.FS
}

// Spec is a loaded, validated workload.
type Spec struct {
	Workload types.Workload
	Ext      Ext
	// Notes are changes made on the way in, such as the deprecated list form
	// of `files` turned into a map.
	Notes []string
}

// Name is metadata.name.
func (s *Spec) Name() string {
	name, _ := s.Workload.Metadata["name"].(string)
	return name
}

// The schema is compiled once; score-go's schema.Validate compiles it on
// every call, which alone costs more than a render.
var compiledSchema = sync.OnceValues(func() (*jsonschema.Schema, error) {
	return jsonschema.CompileString("score-v1b1.json", schema.ScoreSchemaV1b1)
})

// Load parses the Score file, merges the overrides, validates the result
// against the v1b1 schema, embeds file sources and reads the kubeast.io/*
// annotations. Every problem found is returned together.
func Load(in Input) (*Spec, error) {
	var raw map[string]interface{}
	if err := loader.ParseYAML(&raw, bytes.NewReader(in.Score)); err != nil {
		return nil, fmt.Errorf("score file: %w", err)
	}
	if raw == nil {
		raw = map[string]interface{}{}
	}
	for i, o := range in.Overrides {
		var ov map[string]interface{}
		if err := loader.ParseYAML(&ov, bytes.NewReader(o)); err != nil {
			return nil, fmt.Errorf("overrides file %d: %w", i+1, err)
		}
		raw, _ = framework.OverrideMapInMap(raw, ov)
	}

	notes, err := schema.ApplyCommonUpgradeTransforms(raw)
	if err != nil {
		return nil, fmt.Errorf("score file: %w", err)
	}
	compiled, err := compiledSchema()
	if err != nil {
		return nil, fmt.Errorf("score schema: %w", err)
	}
	if err := compiled.Validate(raw); err != nil {
		return nil, schemaError(err)
	}

	s := &Spec{Notes: notes}
	if err := loader.MapSpec(&s.Workload, raw); err != nil {
		return nil, fmt.Errorf("score file: %w", err)
	}

	var errs []error
	if err := embedFiles(&s.Workload, in.Files); err != nil {
		errs = append(errs, err)
	}
	s.Ext, err = ParseExt(s.Workload.Metadata)
	if err != nil {
		errs = append(errs, err)
	}
	if err := refuseUnsupported(&s.Workload); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return s, nil
}

// schemaError lists each failing location instead of jsonschema's nested
// summary, so a person sees every problem in one answer.
func schemaError(err error) error {
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		return fmt.Errorf("score schema: %w", err)
	}
	var lines []string
	for _, u := range ve.BasicOutput().Errors {
		if u.Error == "" || strings.HasPrefix(u.Error, "doesn't validate with") {
			continue
		}
		loc := u.InstanceLocation
		if loc == "" {
			loc = "/"
		}
		lines = append(lines, fmt.Sprintf("%s: %s", loc, u.Error))
	}
	sort.Strings(lines)
	if len(lines) == 0 {
		return fmt.Errorf("score schema: %w", err)
	}
	return fmt.Errorf("score schema: %s", strings.Join(lines, "; "))
}

// embedFiles replaces a file's `source` with its content, as score-go's
// loader.Normalize does, but reads from fsys so the files can come from a
// git checkout or the database instead of the local disk. A path may not
// leave fsys.
func embedFiles(w *types.Workload, fsys fs.FS) error {
	var errs []error
	for _, cname := range sortedKeys(w.Containers) {
		c := w.Containers[cname]
		for _, target := range sortedKeys(c.Files) {
			f := c.Files[target]
			if f.Source == nil {
				continue
			}
			p := path.Clean(strings.TrimPrefix(*f.Source, "./"))
			switch {
			case fsys == nil:
				errs = append(errs, fmt.Errorf("container %q file %q: source files are not available here, use content", cname, target))
				continue
			case path.IsAbs(p) || p == ".." || strings.HasPrefix(p, "../"):
				errs = append(errs, fmt.Errorf("container %q file %q: source %q must stay next to the score file", cname, target, *f.Source))
				continue
			}
			data, err := fs.ReadFile(fsys, p)
			if err != nil {
				errs = append(errs, fmt.Errorf("container %q file %q: %w", cname, target, err))
				continue
			}
			f.Source = nil
			if utf8.Valid(data) {
				content := string(data)
				f.Content = &content
			} else {
				content := base64.StdEncoding.EncodeToString(data)
				f.BinaryContent = &content
			}
			c.Files[target] = f
		}
	}
	return errors.Join(errs...)
}

// refuseUnsupported names the Score fields this version does not render, so
// they fail instead of being dropped without a word.
func refuseUnsupported(w *types.Workload) error {
	var errs []error
	for _, cname := range sortedKeys(w.Containers) {
		if len(w.Containers[cname].Before) > 0 {
			errs = append(errs, fmt.Errorf("container %q: `before` is not supported in this version", cname))
		}
	}
	for _, id := range sortedKeys(w.Resources) {
		if w.Resources[id].Id != nil {
			errs = append(errs, fmt.Errorf("resource %q: shared resources (`id`) are not supported in this version", id))
		}
	}
	return errors.Join(errs...)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
