package config

import "testing"

// The timeline's changes routes are served with the chat's switch or an investigation's step 0, and with neither not
// at all; each read with the one switch rule (services/pkg/config.SwitchOn).
func TestTimelineChangesViewFollowsEitherSwitch(t *testing.T) {
	for _, c := range []struct {
		chat, stepZero string
		want           bool
	}{
		{"", "", false},
		{"false", "0", false},
		{"true", "", true},
		{"", "true", true},
		{"yes", "", true},
		{"", "On", true},
	} {
		t.Setenv("AI_TIMELINE_CHANGES", c.chat)
		t.Setenv("ALERT_INVESTIGATION_CHANGES_FIRST", c.stepZero)
		if got := Load().TimelineChangesView; got != c.want {
			t.Errorf("AI_TIMELINE_CHANGES=%q ALERT_INVESTIGATION_CHANGES_FIRST=%q: %v, want %v", c.chat, c.stepZero, got, c.want)
		}
	}
}
