package config

import "testing"

// The timeline's changes routes are served with the chat's switch, or with alert investigations on and their step 0
// reading them, and otherwise not at all; each read with the one switch rule (services/pkg/config.SwitchOn).
func TestTimelineChangesViewFollowsEitherSwitch(t *testing.T) {
	for _, c := range []struct {
		chat, investigations, stepZero string
		want                           bool
	}{
		{"", "", "", false},
		{"false", "false", "0", false},
		{"true", "", "", true},
		{"yes", "", "", true},
		{"", "", "true", false}, // step 0's switch without investigations
		{"", "true", "", false},
		{"", "true", "On", true},
	} {
		t.Setenv("AI_TIMELINE_CHANGES", c.chat)
		t.Setenv("ALERT_INVESTIGATION_ENABLED", c.investigations)
		t.Setenv("ALERT_INVESTIGATION_CHANGES_FIRST", c.stepZero)
		if got := Load().TimelineChangesView; got != c.want {
			t.Errorf("%+v: %v, want %v", c, got, c.want)
		}
	}
}
