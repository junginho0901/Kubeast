package helm

import "testing"

func TestSectionKindIsValid(t *testing.T) {
	cases := []struct {
		in   SectionKind
		want bool
	}{
		{SectionManifest, true},
		{SectionValues, true},
		{SectionNotes, true},
		{SectionHooks, true},
		{SectionKind(""), false},
		{SectionKind("bogus"), false},
	}
	for _, c := range cases {
		if got := c.in.IsValid(); got != c.want {
			t.Errorf("SectionKind(%q).IsValid() = %v, want %v", string(c.in), got, c.want)
		}
	}
}
