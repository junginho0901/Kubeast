package model

import (
	"sort"
	"testing"
)

func TestValues(t *testing.T) {
	for _, e := range []Enum{EnumPanelKind, EnumStore, EnumVariableKind, EnumMatcherKind, EnumColorToken,
		EnumCursorSync, EnumRefreshPoint, EnumThresholdMode, EnumRepeatDir, EnumSourceKind} {
		got := Values(e)
		if len(got) == 0 {
			t.Errorf("%s: no values", e)
		}
		if !sort.StringsAreSorted(got) {
			t.Errorf("%s: not sorted: %v", e, got)
		}
		for _, v := range got {
			if v == "" {
				t.Errorf("%s: lists the empty string", e)
			}
		}
		got[0] = "changed"
		if Values(e)[0] == "changed" {
			t.Errorf("%s: returns the validator's own list", e)
		}
	}
	if got := Values(EnumCursorSync); len(got) != 3 {
		t.Errorf("cursorSync: want none, shared, sharedTooltip; got %v", got)
	}
	if got := Values("nope"); len(got) != 0 {
		t.Errorf("unknown enum: want nothing, got %v", got)
	}
}
