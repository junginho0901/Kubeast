package controller

import "testing"

// The controller is built without the shared services/pkg module, so its copy
// of the required schema version must follow dbmigrate.Required by hand.
func TestRequiredSchemaVersion(t *testing.T) {
	if requiredSchemaVersion != 2 {
		t.Fatalf("requiredSchemaVersion = %d; keep it equal to services/pkg/dbmigrate.Required", requiredSchemaVersion)
	}
}
