package config

import "testing"

func TestAnUnknownRoleIsRefusedAndNoneIsTheWholeService(t *testing.T) {
	for in, want := range map[string]Role{"": RoleAll, "all": RoleAll, " API ": RoleAPI, "stream": RoleStream} {
		got, err := ParseRole(in)
		if err != nil || got != want {
			t.Errorf("ParseRole(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"streams", "query", "api,stream"} {
		if _, err := ParseRole(in); err == nil {
			t.Errorf("ParseRole(%q) took a role that does not exist", in)
		}
	}
}

func TestEachRoleServesItsHalfAndAllServesBoth(t *testing.T) {
	for role, want := range map[Role][2]bool{RoleAll: {true, true}, RoleAPI: {true, false}, RoleStream: {false, true}} {
		if got := [2]bool{role.ServesAPI(), role.ServesStreams()}; got != want {
			t.Errorf("%s: api %v streams %v, want %v", role, got[0], got[1], want)
		}
	}
}

func TestTheRoleComesFromServerRole(t *testing.T) {
	t.Setenv("SERVER_ROLE", "stream")
	if got := Load().ServerRole; got != "stream" {
		t.Fatalf("ServerRole = %q", got)
	}
}
