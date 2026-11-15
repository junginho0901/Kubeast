package ws

import (
	"bytes"
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	utiljson "k8s.io/apimachinery/pkg/util/json"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// client-go's dynamic client decodes each watch event's object whole into maps, and a row reads little of it: in
// TestWSMemoryPerUser that decoding was 70 % of all the bytes allocated, and what made 700 people reopening their
// screens at once hold 640 KiB more each. The watches here go through a client of the same REST config whose decoder
// skips, in the bytes, what the row of the event's kind does not read (watchShapes), and builds the same maps of the
// rest with the same JSON decoder, so the row is the row of the whole object (TestRowsOfTheDecodedPartAreTheRowsOfTheWholeObject).
// A kind without a shape, a Status and anything the decoder does not follow go to client-go's decoder as before.

// shape is what a row reads of a JSON value. nil reads it whole. Otherwise it reads the fields named in fields of an
// object, or of each object of a list, each by its own shape (a field set to skip is left out), and with others every
// field it does not name, whole. A value of another type than the shape expects is read whole, as the full decoder reads it.
type shape struct {
	fields map[string]*shape
	others bool
}

// skip leaves a field out of a shape with others.
var skip = &shape{}

func fields(named map[string]*shape) *shape { return &shape{fields: named} }

// watchShapeOf is what the rows read of an event of apiVersion and kind; nil = the whole object.
type watchShapeOf func(apiVersion, kind string) *shape

// rowShapes reads what objectToInfo reads of the kinds in watchShapes.
func rowShapes(apiVersion, kind string) *shape {
	group, _, _ := strings.Cut(apiVersion, "/")
	if !strings.Contains(apiVersion, "/") {
		group = ""
	}
	return watchShapes[schema.GroupKind{Group: group, Kind: kind}]
}

// changesShape reads, of any kind, what a watch of changes reads (forwardChanges): the resourceVersion.
func changesShape(_, kind string) *shape {
	if kind == "Status" {
		return nil
	}
	return changesOnly
}

var changesOnly = fields(map[string]*shape{"apiVersion": nil, "kind": nil, "metadata": fields(map[string]*shape{"resourceVersion": nil})})

// rowSerializer is client-go's JSON serializer with a Decode that reads only an object's shape.
type rowSerializer struct {
	runtime.Serializer
	shapeOf watchShapeOf
}

func (s rowSerializer) Decode(data []byte, defaults *schema.GroupVersionKind, into runtime.Object) (runtime.Object, *schema.GroupVersionKind, error) {
	if into == nil {
		if apiVersion, kind, ok := topKind(data); ok {
			if sh := s.shapeOf(apiVersion, kind); sh != nil {
				if object, err := decodeShape(data, sh); err == nil {
					gvk := schema.FromAPIVersionAndKind(apiVersion, kind)
					return &unstructured.Unstructured{Object: object}, &gvk, nil
				}
			}
		}
	}
	return s.Serializer.Decode(data, defaults, into)
}

// rowNegotiator gives the dynamic client's JSON serializer with rowSerializer's Decode.
type rowNegotiator struct {
	runtime.NegotiatedSerializer
	infos []runtime.SerializerInfo
}

func (n rowNegotiator) SupportedMediaTypes() []runtime.SerializerInfo { return n.infos }

// newRowWatchClient is a dynamic client of cfg, as client-go makes one, whose objects decode by shapeOf. It speaks JSON
// only.
func newRowWatchClient(cfg *rest.Config, shapeOf watchShapeOf) (dynamic.Interface, error) {
	c := dynamic.ConfigFor(watchStreamConfig(cfg))
	c.ContentType, c.AcceptContentTypes = runtime.ContentTypeJSON, runtime.ContentTypeJSON
	var infos []runtime.SerializerInfo
	for _, info := range c.NegotiatedSerializer.SupportedMediaTypes() {
		if info.MediaType == runtime.ContentTypeJSON {
			info.Serializer = rowSerializer{Serializer: info.Serializer, shapeOf: shapeOf}
			infos = append(infos, info)
		}
	}
	if len(infos) == 0 {
		return nil, errors.New("the dynamic client has no JSON serializer")
	}
	c.NegotiatedSerializer = rowNegotiator{NegotiatedSerializer: c.NegotiatedSerializer, infos: infos}
	c.GroupVersion = nil
	c.APIPath = "/if-you-see-this-search-for-the-break"
	rc, err := rest.UnversionedRESTClientFor(c)
	if err != nil {
		return nil, err
	}
	return dynamic.New(rc), nil
}

// RESTConfigProvider, which the k8s Service implements, gives the REST config of the cluster in ctx, the one
// DynamicForCtx's client was made of.
type RESTConfigProvider interface {
	RESTConfigFor(ctx context.Context) (*rest.Config, error)
}

type rowClientKey struct {
	cfg     *rest.Config
	changes bool
}

// rowClients are made once per REST config, which a cluster's reload replaces: past maxRowClients they are all made
// again as they are asked for.
const maxRowClients = 64

type rowClientCache struct {
	mu      sync.Mutex
	clients map[rowClientKey]dynamic.Interface
}

// watchClient is the client a watch of the cluster in ctx goes through: one that decodes what the rows read (changes:
// the resourceVersion only), or fallback when the provider gives no REST config or the client cannot be made.
func (m *Multiplexer) watchClient(ctx context.Context, fallback dynamic.Interface, changes bool) dynamic.Interface {
	p, ok := m.provider.(RESTConfigProvider)
	if !ok {
		return fallback
	}
	cfg, err := p.RESTConfigFor(ctx)
	if err != nil || cfg == nil {
		return fallback
	}
	key := rowClientKey{cfg: cfg, changes: changes}
	m.rowClients.mu.Lock()
	defer m.rowClients.mu.Unlock()
	if c, ok := m.rowClients.clients[key]; ok {
		return c
	}
	shapeOf := watchShapeOf(rowShapes)
	if changes {
		shapeOf = changesShape
	}
	c, err := newRowWatchClient(cfg, shapeOf)
	if err != nil {
		return fallback
	}
	if m.rowClients.clients == nil || len(m.rowClients.clients) >= maxRowClients {
		m.rowClients.clients = make(map[rowClientKey]dynamic.Interface)
	}
	m.rowClients.clients[key] = c
	return c
}

// errShape is JSON the shape decoder does not follow; client-go's decoder then reads it.
var errShape = errors.New("not an object the shape decoder follows")

// topKind reads the apiVersion and kind of a JSON object without decoding the rest.
func topKind(data []byte) (apiVersion, kind string, ok bool) {
	c := cursor{b: data}
	err := c.object(func(key []byte) error {
		switch string(key) {
		case "apiVersion", "kind":
			start := c.i
			if err := c.skipValue(); err != nil {
				return err
			}
			var s string
			if err := utiljson.Unmarshal(c.b[start:c.i], &s); err != nil {
				return err
			}
			if string(key) == "kind" {
				kind = s
			} else {
				apiVersion = s
			}
			return nil
		}
		return c.skipValue()
	})
	return apiVersion, kind, err == nil && kind != ""
}

// decodeShape decodes the JSON object data as far as sh reads it.
func decodeShape(data []byte, sh *shape) (map[string]interface{}, error) {
	c := cursor{b: data}
	c.space()
	if c.i >= len(c.b) || c.b[c.i] != '{' {
		return nil, errShape
	}
	v, err := c.value(sh)
	if err != nil {
		return nil, err
	}
	c.space()
	if c.i != len(c.b) {
		return nil, errShape
	}
	object, _ := v.(map[string]interface{})
	return object, nil
}

// cursor walks JSON that client-go's framer has already read as one whole value.
type cursor struct {
	b []byte
	i int
}

func (c *cursor) space() {
	for c.i < len(c.b) {
		switch c.b[c.i] {
		case ' ', '\t', '\n', '\r':
			c.i++
		default:
			return
		}
	}
}

// value decodes the value at the cursor as far as sh reads it.
func (c *cursor) value(sh *shape) (interface{}, error) {
	c.space()
	if c.i >= len(c.b) {
		return nil, errShape
	}
	switch {
	case sh != nil && c.b[c.i] == '{':
		out := make(map[string]interface{})
		err := c.object(func(key []byte) error {
			field, named := sh.fields[string(key)]
			switch {
			case field == skip || !named && !sh.others:
				return c.skipValue()
			case !named:
				field = nil
			}
			v, err := c.value(field)
			if err != nil {
				return err
			}
			out[string(key)] = v
			return nil
		})
		return out, err
	case sh != nil && c.b[c.i] == '[':
		out := []interface{}{}
		c.i++
		c.space()
		if c.i < len(c.b) && c.b[c.i] == ']' {
			c.i++
			return out, nil
		}
		for {
			v, err := c.value(sh)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
			c.space()
			if c.i >= len(c.b) {
				return nil, errShape
			}
			switch c.b[c.i] {
			case ',':
				c.i++
			case ']':
				c.i++
				return out, nil
			default:
				return nil, errShape
			}
		}
	}
	start := c.i
	if err := c.skipValue(); err != nil {
		return nil, err
	}
	if v, ok := scalar(c.b[start:c.i]); ok {
		return v, nil
	}
	var v interface{}
	if err := utiljson.Unmarshal(c.b[start:c.i], &v); err != nil {
		return nil, err
	}
	return v, nil
}

// scalar reads a string without escapes, a number, true, false or null as utiljson.Unmarshal does (a whole number that
// fits as an int64, else a float64), without its decoder's state for each value; anything else is left to it.
func scalar(b []byte) (interface{}, bool) {
	switch b[0] {
	case '"':
		text := b[1 : len(b)-1]
		if bytes.IndexByte(text, '\\') >= 0 || !utf8.Valid(text) {
			return nil, false
		}
		return string(text), true
	case 't':
		return true, string(b) == "true"
	case 'f':
		return false, string(b) == "false"
	case 'n':
		return nil, string(b) == "null"
	case '{', '[':
		return nil, false
	}
	if !validNumber(b) {
		return nil, false
	}
	if n, err := strconv.ParseInt(string(b), 10, 64); err == nil {
		return n, true
	}
	if f, err := strconv.ParseFloat(string(b), 64); err == nil {
		return f, true
	}
	return nil, false
}

// validNumber is JSON's number grammar, which strconv's is wider than (hex, underscores, "inf", a leading "+").
func validNumber(b []byte) bool {
	i := 0
	if i < len(b) && b[i] == '-' {
		i++
	}
	digits := func() int {
		start := i
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
		}
		return i - start
	}
	if i < len(b) && b[i] == '0' {
		i++
	} else if digits() == 0 {
		return false
	}
	if i < len(b) && b[i] == '.' {
		i++
		if digits() == 0 {
			return false
		}
	}
	if i < len(b) && (b[i] == 'e' || b[i] == 'E') {
		i++
		if i < len(b) && (b[i] == '+' || b[i] == '-') {
			i++
		}
		if digits() == 0 {
			return false
		}
	}
	return i == len(b)
}

// object calls field with each key of the object at the cursor (unescaped), which leaves the cursor after its value.
func (c *cursor) object(field func(key []byte) error) error {
	c.space()
	if c.i >= len(c.b) || c.b[c.i] != '{' {
		return errShape
	}
	c.i++
	c.space()
	if c.i < len(c.b) && c.b[c.i] == '}' {
		c.i++
		return nil
	}
	for {
		c.space()
		start := c.i
		if err := c.skipString(); err != nil {
			return err
		}
		key := c.b[start+1 : c.i-1]
		for _, ch := range key {
			if ch == '\\' {
				var s string
				if err := utiljson.Unmarshal(c.b[start:c.i], &s); err != nil {
					return err
				}
				key = []byte(s)
				break
			}
		}
		c.space()
		if c.i >= len(c.b) || c.b[c.i] != ':' {
			return errShape
		}
		c.i++
		if err := field(key); err != nil {
			return err
		}
		c.space()
		if c.i >= len(c.b) {
			return errShape
		}
		switch c.b[c.i] {
		case ',':
			c.i++
		case '}':
			c.i++
			return nil
		default:
			return errShape
		}
	}
}

func (c *cursor) skipString() error {
	if c.i >= len(c.b) || c.b[c.i] != '"' {
		return errShape
	}
	for c.i++; c.i < len(c.b); c.i++ {
		switch c.b[c.i] {
		case '\\':
			c.i++
		case '"':
			c.i++
			return nil
		}
	}
	return errShape
}

// skipValue moves the cursor past one value without decoding it.
func (c *cursor) skipValue() error {
	c.space()
	if c.i >= len(c.b) {
		return errShape
	}
	switch c.b[c.i] {
	case '"':
		return c.skipString()
	case '{', '[':
		depth := 0
		for c.i < len(c.b) {
			switch c.b[c.i] {
			case '"':
				if err := c.skipString(); err != nil {
					return err
				}
				continue
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					c.i++
					return nil
				}
			}
			c.i++
		}
		return errShape
	}
	start := c.i
	for c.i < len(c.b) {
		switch c.b[c.i] {
		case ',', '}', ']', ' ', '\t', '\n', '\r':
			if c.i == start {
				return errShape
			}
			return nil
		}
		c.i++
	}
	if c.i == start {
		return errShape
	}
	return nil
}
