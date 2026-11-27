package main

import "testing"

// The service check reads EndpointSlices: ready and unset conditions count as
// ready, false as not ready, across every slice of the Service.
func TestParseEndpointSlices(t *testing.T) {
	out := `{"items":[
	  {"endpoints":[{"addresses":["10.0.0.1"],"conditions":{"ready":true}},{"addresses":["10.0.0.2","10.0.0.3"],"conditions":{"ready":false}}]},
	  {"endpoints":[{"addresses":["10.0.0.4"],"conditions":{}}]}
	]}`
	ready, notReady, err := parseEndpointSlices(out)
	if ready != 2 || notReady != 2 || err != nil {
		t.Fatalf("ready=%d notReady=%d %v", ready, notReady, err)
	}
	if r, n, err := parseEndpointSlices(`{"items":[]}`); r != 0 || n != 0 || err != nil {
		t.Fatalf("empty list: %d %d %v", r, n, err)
	}
	// no list, or one the output cap cut: not a count of none
	for _, bad := range []string{"not json", "", out[:40] + "\n… [output cut]"} {
		if r, n, err := parseEndpointSlices(bad); r != 0 || n != 0 || err == nil {
			t.Fatalf("%q: %d %d %v", bad, r, n, err)
		}
	}
}
