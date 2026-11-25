package config

import "testing"

// The timeline's changes routes are served with the chat's switch, or with alert investigations on and their step 0
// reading them, and otherwise not at all; the v0.7.9 switches read with the one switch rule (services/pkg/config.SwitchOn).
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

// ALERT_INVESTIGATION_ENABLED (0.7.8) is read as AlertInvestigationEnabled reads it, not by the v0.7.9 rule: where
// /cluster/features says investigations are off, step 0's switch opens no route.
func TestTimelineChangesViewReadsInvestigationsAsAlertInvestigationEnabled(t *testing.T) {
	t.Setenv("AI_TIMELINE_CHANGES", "")
	t.Setenv("ALERT_INVESTIGATION_CHANGES_FIRST", "true")
	for _, v := range []string{"true", "TRUE", "1", "yes", "on", "false", ""} {
		t.Setenv("ALERT_INVESTIGATION_ENABLED", v)
		if c := Load(); c.TimelineChangesView != c.AlertInvestigationEnabled {
			t.Errorf("ALERT_INVESTIGATION_ENABLED=%q: changes view %v, investigations %v", v, c.TimelineChangesView, c.AlertInvestigationEnabled)
		}
	}
}

// AI_TIMELINE_CHANGES_MORE is a switch of its own, read by the one switch rule: it opens no route by itself.
func TestTimelineChangesMoreIsASwitchOfItsOwn(t *testing.T) {
	for _, name := range []string{"AI_TIMELINE_CHANGES", "ALERT_INVESTIGATION_ENABLED", "ALERT_INVESTIGATION_CHANGES_FIRST"} {
		t.Setenv(name, "")
	}
	for value, want := range map[string]bool{"": false, "false": false, "0": false, "maybe": false, "true": true, "On": true, "1": true, "yes": true} {
		t.Setenv("AI_TIMELINE_CHANGES_MORE", value)
		if c := Load(); c.TimelineChangesMore != want || c.TimelineChangesView {
			t.Errorf("AI_TIMELINE_CHANGES_MORE=%q: more %v, want %v; view %v, want false", value, c.TimelineChangesMore, want, c.TimelineChangesView)
		}
	}
}
