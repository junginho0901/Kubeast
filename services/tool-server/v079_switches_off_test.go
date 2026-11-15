package main

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// What the model reads of the ai_models tool beside its rows is aiModelsNote. With every v0.7.9 switch off it is the text
// of main d58cf599 (0.7.8's), held as its sha256, as ai-service's test_v079_switches_off.py holds the chat's messages and
// tool definitions.
func TestWithEveryV079SwitchOffTheAIModelsNoteIsV078s(t *testing.T) {
	const v078 = "2b86f551d2fda9dd730e2cf6a9b070938b0479b97878f7e5792046e414a80382"
	sum := sha256.Sum256([]byte(aiModelsNote))
	if got := hex.EncodeToString(sum[:]); got != v078 {
		t.Errorf("aiModelsNote's sha256 is %s, 0.7.8's %s: %q", got, v078, aiModelsNote)
	}
}
