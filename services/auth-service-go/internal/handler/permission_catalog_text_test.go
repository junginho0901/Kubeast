package handler

import (
	"encoding/json"
	"strings"
	"testing"
)

// resource.*.read opens the lists and details and what asks more, and the cluster's RBAC still decides what the group
// sees: the catalog's description says so, the same words as the English catalog of the role screen.
func TestPermissionCatalog_ReadSaysWhatAsksForIt(t *testing.T) {
	var categories []struct {
		Permissions []struct {
			Key         string `json:"key"`
			Description string `json:"description"`
		} `json:"permissions"`
	}
	raw, _ := json.Marshal(allPermissions())
	if err := json.Unmarshal(raw, &categories); err != nil {
		t.Fatal(err)
	}
	description := ""
	for _, c := range categories {
		for _, p := range c.Permissions {
			if p.Key == "resource.*.read" {
				description = p.Description
			}
		}
	}
	if strings.Contains(strings.ToLower(description), "all resources") {
		t.Errorf("description %q promises every resource", description)
	}
	for _, word := range []string{"lists and details", "Pod logs", "Helm", "Cost", "cluster's RBAC"} {
		if !strings.Contains(description, word) {
			t.Errorf("description %q does not say %q", description, word)
		}
	}
}
