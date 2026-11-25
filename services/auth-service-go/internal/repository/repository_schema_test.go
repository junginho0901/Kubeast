package repository

import (
	"slices"
	"strings"
	"testing"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// The investigator's token holds the Read role's tools, no other tool, and two reads. ai-service's
// tests/test_read_tool_lists.py holds the Read role's tools equal to READONLY_TOOL_NAMES.
func TestInvestigatorPermissions_AreTheReadToolsAndTwoReads(t *testing.T) {
	var tools, rest []string
	for _, p := range InvestigatorPermissions {
		if strings.HasPrefix(p, "ai.tool.") {
			tools = append(tools, p)
		} else {
			rest = append(rest, p)
		}
	}
	if !slices.Equal(tools, ReadAIToolPermissions) {
		t.Errorf("investigator tools %v, want ReadAIToolPermissions %v", tools, ReadAIToolPermissions)
	}
	if want := []string{auth.PermObjectsRead, "resource.pod.read"}; !slices.Equal(rest, want) {
		t.Errorf("investigator's other keys %v, want %v", rest, want)
	}
}
