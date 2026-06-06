package cluster

import "testing"

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Prod East 1":     "prod-east-1",
		"  staging  ":     "staging",
		"PROD":            "prod",
		"prod_cluster.01": "prod-cluster-01",
		"a---b":           "a-b",
		"--lead--":        "lead",
		"한글 cluster":      "cluster",
		"!!!":             "",
		"":                "",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}
