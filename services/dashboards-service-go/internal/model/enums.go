package model

import "sort"

// Enum names the value lists the validator accepts, for callers that publish
// them (the JSON Schema). Each returns a sorted copy, so a caller cannot change
// what Validate checks.
type Enum string

const (
	EnumPanelKind     Enum = "panelKind"
	EnumStore         Enum = "store"
	EnumVariableKind  Enum = "variableKind"
	EnumMatcherKind   Enum = "matcherKind"
	EnumColorToken    Enum = "colorToken"
	EnumCursorSync    Enum = "cursorSync"
	EnumRefreshPoint  Enum = "refreshPoint"
	EnumThresholdMode Enum = "thresholdMode"
	EnumRepeatDir     Enum = "repeatDirection"
)

var thresholdModes = map[string]bool{"absolute": true, "percentage": true}
var repeatDirections = map[string]bool{"h": true, "v": true}

// Values lists an enum's accepted values, without the empty string that some
// optional fields allow by being left out.
func Values(e Enum) []string {
	src := map[Enum]map[string]bool{
		EnumPanelKind: PanelKinds, EnumStore: stores, EnumVariableKind: variableKinds, EnumMatcherKind: matcherKinds,
		EnumColorToken: ColorTokens, EnumCursorSync: cursorSyncs, EnumRefreshPoint: refreshPoints,
		EnumThresholdMode: thresholdModes, EnumRepeatDir: repeatDirections,
	}[e]
	out := make([]string, 0, len(src))
	for v := range src {
		if v != "" {
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
