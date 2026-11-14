package controller

import "testing"

// O-27: the controller's connections set no session limits (PostgreSQL's default is 0, no limit for each).
func TestDBConnConfigCarriesTheSessionLimits(t *testing.T) {
	for _, l := range dbSessionLimits {
		t.Setenv(l.env, "")
	}
	cfg, err := dbConnConfig("postgresql+asyncpg://kubeast:pw@db.example:5432/kubeast")
	if err != nil {
		t.Fatalf("dbConnConfig: %v", err)
	}
	want := map[string]string{
		"statement_timeout":                   "30000",
		"lock_timeout":                        "15000",
		"idle_in_transaction_session_timeout": "300000",
	}
	for k, v := range want {
		if got := cfg.RuntimeParams[k]; got != v {
			t.Fatalf("RuntimeParams[%s] = %q, want %q", k, got, v)
		}
	}
	if cfg.Host != "db.example" || cfg.Database != "kubeast" {
		t.Fatalf("host, database = %q, %q", cfg.Host, cfg.Database)
	}
}

func TestDBConnConfigReadsTheVariables(t *testing.T) {
	t.Setenv("DB_STATEMENT_TIMEOUT_MS", "45000")
	t.Setenv("DB_LOCK_TIMEOUT_MS", "0")
	t.Setenv("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "-5")
	cfg, err := dbConnConfig("postgres://kubeast:pw@db.example:5432/kubeast")
	if err != nil {
		t.Fatalf("dbConnConfig: %v", err)
	}
	if got := cfg.RuntimeParams["statement_timeout"]; got != "45000" {
		t.Fatalf("statement_timeout = %q, want 45000", got)
	}
	if got, ok := cfg.RuntimeParams["lock_timeout"]; ok {
		t.Fatalf("lock_timeout = %q with DB_LOCK_TIMEOUT_MS=0, want it not sent", got)
	}
	if got := cfg.RuntimeParams["idle_in_transaction_session_timeout"]; got != "300000" {
		t.Fatalf("idle_in_transaction_session_timeout = %q for -5, want the default 300000", got)
	}
}

// The controller's copy of the session limits keeps services/pkg/dbsession's variable names and defaults.
func TestDBSessionLimitsFollowTheSharedPackage(t *testing.T) {
	want := map[string]int{
		"DB_STATEMENT_TIMEOUT_MS":           30000,
		"DB_LOCK_TIMEOUT_MS":                15000,
		"DB_IDLE_IN_TRANSACTION_TIMEOUT_MS": 300000,
	}
	if len(dbSessionLimits) != len(want) {
		t.Fatalf("%d limits, want %d", len(dbSessionLimits), len(want))
	}
	for _, l := range dbSessionLimits {
		if want[l.env] != l.def {
			t.Fatalf("%s default %d, want %d (services/pkg/dbsession.Defaults)", l.env, l.def, want[l.env])
		}
	}
}

// The controller is built without the shared services/pkg module, so its copy
// of the required schema version must follow dbmigrate.Required by hand.
func TestRequiredSchemaVersion(t *testing.T) {
	if requiredSchemaVersion != 3 {
		t.Fatalf("requiredSchemaVersion = %d; keep it equal to services/pkg/dbmigrate.Required", requiredSchemaVersion)
	}
}
