package config

import (
	"reflect"
	"testing"
)

func TestLookupEnvList_EmptyMeansNone(t *testing.T) {
	const key = "KUBEAST_TEST_LIST"
	t.Setenv(key, "")
	if got := LookupEnvList(key, "a,b"); len(got) != 0 {
		t.Fatalf("set to empty must be none, got %v", got)
	}
	if got := GetEnvList(key, "a,b"); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("GetEnvList keeps treating empty as unset: %v", got)
	}
	t.Setenv(key, " x , ,y ")
	if got := LookupEnvList(key, "a,b"); !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Fatalf("trimmed, blanks dropped: %v", got)
	}
}

func TestLookupEnvList_AbsentUsesDefault(t *testing.T) {
	const key = "KUBEAST_TEST_LIST_ABSENT"
	if got := LookupEnvList(key, "a, b"); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("absent → default: %v", got)
	}
	if got := LookupEnvList(key, ""); len(got) != 0 {
		t.Fatalf("absent with an empty default → none: %v", got)
	}
}

func TestLookupEnv_EmptyMeansNone(t *testing.T) {
	const key = "KUBEAST_TEST_STRING"
	if got := LookupEnv(key, "d"); got != "d" {
		t.Fatalf("absent → default: %q", got)
	}
	t.Setenv(key, "")
	if got := LookupEnv(key, "d"); got != "" {
		t.Fatalf("set to empty must be none, got %q", got)
	}
	if got := GetEnv(key, "d"); got != "d" {
		t.Fatalf("GetEnv keeps treating empty as unset: %q", got)
	}
	t.Setenv(key, "v")
	if got := LookupEnv(key, "d"); got != "v" {
		t.Fatalf("set → value: %q", got)
	}
}
