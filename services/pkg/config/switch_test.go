package config

import (
	"encoding/json"
	"os"
	"testing"
)

// switchCasesFile is read by ai-service's test_switch_cases.py too: one rule for a switch's value in both languages.
const switchCasesFile = "../../ai-service/tests/fixtures/switch_cases.json"

func TestSwitchCases(t *testing.T) {
	raw, err := os.ReadFile(switchCasesFile)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Value string `json:"value"`
			On    bool   `json:"on"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 10 {
		t.Fatalf("only %d cases", len(file.Cases))
	}
	for _, c := range file.Cases {
		if got := SwitchOn(c.Value); got != c.On {
			t.Errorf("SwitchOn(%q) = %v, want %v", c.Value, got, c.On)
		}
		t.Setenv("KUBEAST_TEST_SWITCH", c.Value)
		if got := EnvSwitch("KUBEAST_TEST_SWITCH"); got != c.On {
			t.Errorf("EnvSwitch with %q = %v, want %v", c.Value, got, c.On)
		}
	}
	os.Unsetenv("KUBEAST_TEST_SWITCH")
	if EnvSwitch("KUBEAST_TEST_SWITCH") {
		t.Error("an unset switch is on")
	}
}
