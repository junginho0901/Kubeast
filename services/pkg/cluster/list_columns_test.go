package cluster

import (
	"regexp"
	"slices"
	"strings"
	"testing"
)

// List reads every column Get reads into an Info: Get alone reads the columns naming Secrets, whose values it loads,
// and api_server_url, which no Info field holds. log_search_url read by Get only left a cluster that names its own
// log store off features.logSearch.clusters (k8s-service LogStoreClusters reads List).
func TestListReadsTheColumnsGetReads(t *testing.T) {
	getOnly := []string{"kubeconfig_secret_name", "api_server_url", "prometheus_auth_secret_name", "log_search_auth_secret_name"}
	coalesced := regexp.MustCompile(`COALESCE\((\w+), ''\)`)
	columns := func(list string) []string {
		var out []string
		for _, c := range strings.Split(coalesced.ReplaceAllString(list, "$1"), ",") {
			out = append(out, strings.TrimSpace(c))
		}
		return out
	}
	get, list := columns(getColumns), columns(listColumns)
	for _, c := range getOnly {
		if !slices.Contains(get, c) {
			t.Errorf("Get reads no %s any more: take it off getOnly", c)
		}
	}
	var want []string
	for _, c := range get {
		if !slices.Contains(getOnly, c) {
			want = append(want, c)
		}
	}
	if !slices.Equal(list, want) {
		t.Fatalf("List reads %v, Get reads into an Info %v", list, want)
	}
}
