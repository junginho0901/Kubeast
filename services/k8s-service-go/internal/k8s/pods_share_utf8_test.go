package k8s

import (
	"reflect"
	"testing"
)

type utf8Name string

type utf8Hidden struct{ name string }

type utf8Box struct{ In any }

type utf8Loop struct{ Next *utf8Loop }

// allUTF8 looks into every kind of value a share key can hold, and gives false past its depth, as for a value holding itself.
func TestAllUTF8LooksIntoEveryKindAndStopsAtItsDepth(t *testing.T) {
	good, bad := "a", "a\xbd"
	loop := &utf8Loop{}
	loop.Next = loop
	self := map[string]any{}
	self["self"] = self
	for _, c := range []struct {
		name string
		v    any
		want bool
	}{
		{"nothing", nil, true},
		{"string", good, true},
		{"string not UTF-8", bad, false},
		{"U+FFFD itself", "\xef\xbf\xbd", true},
		{"named string", utf8Name(good), true},
		{"named string not UTF-8", utf8Name(bad), false},
		{"struct", struct{ A, B string }{good, good}, true},
		{"struct field not UTF-8", struct{ A, B string }{good, bad}, false},
		{"unexported field", utf8Hidden{good}, true},
		{"unexported field not UTF-8", utf8Hidden{bad}, false},
		{"slice", []string{good, good}, true},
		{"slice element not UTF-8", []string{good, bad}, false},
		{"array", [2]string{good, good}, true},
		{"array element not UTF-8", [2]string{good, bad}, false},
		{"map", map[string]string{good: good}, true},
		{"map key not UTF-8", map[string]string{bad: good}, false},
		{"map value not UTF-8", map[string]string{good: bad}, false},
		{"nil map", map[string]string(nil), true},
		{"pointer", &good, true},
		{"pointer to a string not UTF-8", &bad, false},
		{"nil pointer", (*string)(nil), true},
		{"interface", utf8Box{good}, true},
		{"interface holding a string not UTF-8", utf8Box{bad}, false},
		{"nil interface", utf8Box{}, true},
		{"[]byte not UTF-8, which json writes as base64", []byte(bad), true},
		{"struct pointing to itself", *loop, false},
		{"map holding itself", self, false},
	} {
		if got := allUTF8(reflect.ValueOf(c.v), shareKeyDepth); got != c.want {
			t.Errorf("%s: allUTF8 = %v, want %v", c.name, got, c.want)
		}
	}
	if !allUTF8(reflect.ValueOf(good), 1) || allUTF8(reflect.ValueOf(&good), 1) || !allUTF8(reflect.ValueOf(&good), 2) {
		t.Error("allUTF8 does not look exactly depth levels in")
	}
}
