package helm

import (
	"reflect"
	"testing"

	"helm.sh/helm/v3/pkg/action"
)

func TestParseStateMask(t *testing.T) {
	cases := []struct {
		in   string
		want action.ListStates
	}{
		{"", action.ListAll},
		{"deployed", action.ListDeployed},
		{"failed", action.ListFailed},
		{"deployed,failed", action.ListDeployed | action.ListFailed},
		{" deployed , pending-upgrade ", action.ListDeployed | action.ListPendingUpgrade},
		{"bogus", action.ListAll},
	}
	for _, c := range cases {
		if got := parseStateMask(c.in); got != c.want {
			t.Errorf("parseStateMask(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestSplitAndTrim(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"a,b,c", []string{"a", "b", "c"}},
		{" a , b ,c", []string{"a", "b", "c"}},
		{"", []string{""}},
		{"solo", []string{"solo"}},
	}
	for _, c := range cases {
		if got := splitAndTrim(c.in, ','); !reflect.DeepEqual(got, c.want) {
			t.Errorf("splitAndTrim(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
