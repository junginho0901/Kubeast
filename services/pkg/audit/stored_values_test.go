package audit

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnOldUpgradeRowIsReadWithoutItsValues(t *testing.T) {
	stored := []byte(`{"newRevision":7,"values":"adminPassword: fake-admin-value\n"}`)
	got := string(readableAfter("helm.release.upgrade", stored))
	if strings.Contains(got, "fake-admin-value") {
		t.Fatalf("the values are readable: %s", got)
	}
	var after map[string]any
	if err := json.Unmarshal([]byte(got), &after); err != nil {
		t.Fatal(err)
	}
	if after["newRevision"] != float64(7) || after["values"] != "***" {
		t.Fatalf("after = %v", after)
	}
}

func TestANewUpgradeRowIsReadAsItWasWritten(t *testing.T) {
	stored := `{"newRevision":8,"values_len":12,"values_keys":["replicas"],"values_sha256":"abc"}`
	if got := string(readableAfter("helm.release.upgrade", []byte(stored))); got != stored {
		t.Fatalf("got %s", got)
	}
}

func TestOtherActionsKeepAFieldOfThatName(t *testing.T) {
	stored := `{"values":"not a helm upgrade"}`
	if got := string(readableAfter("k8s.other.action", []byte(stored))); got != stored {
		t.Fatalf("got %s", got)
	}
}

func TestAnUnreadableRowIsLeftAlone(t *testing.T) {
	for _, stored := range []string{"", "not json", `["values"]`} {
		if got := string(readableAfter("helm.release.upgrade", []byte(stored))); got != stored {
			t.Errorf("%q became %q", stored, got)
		}
	}
}

func TestMaskInvalidValuesLeavesWhatWasWrong(t *testing.T) {
	cases := []struct{ in, want string }{
		{`spec.x: Invalid value: "fake-value": must not be set`, `spec.x: Invalid value: "***": must not be set`},
		{`spec.x: Invalid value: "with \"quotes\" inside": bad`, `spec.x: Invalid value: "***": bad`},
		{`a: Invalid value: "one": bad, b: Invalid value: "two": worse`, `a: Invalid value: "***": bad, b: Invalid value: "***": worse`},
		{`spec.replicas: Invalid value: -1: must be greater than or equal to 0`, `spec.replicas: Invalid value: ***: must be greater than or equal to 0`},
		{`spec.c: Invalid value: core.Container{Image:"fake-value"}: bad`, `spec.c: Invalid value: ***: bad`},
		{`pods "web" is forbidden: nope`, `pods "web" is forbidden: nope`},
	}
	for _, tc := range cases {
		if got := MaskInvalidValues(tc.in); got != tc.want {
			t.Errorf("%q\n got %q\nwant %q", tc.in, got, tc.want)
		}
	}
}
