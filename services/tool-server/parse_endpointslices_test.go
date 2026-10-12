package main

import "testing"

// The service check reads EndpointSlices: ready and unset conditions count as
// ready, false as not ready, across every slice of the Service.
func TestParseEndpointSlices(t *testing.T) {
	out := `{"items":[
	  {"endpoints":[{"addresses":["10.0.0.1"],"conditions":{"ready":true}},{"addresses":["10.0.0.2","10.0.0.3"],"conditions":{"ready":false}}]},
	  {"endpoints":[{"addresses":["10.0.0.4"],"conditions":{}}]}
	]}`
	ready, notReady := parseEndpointSlices(out)
	if ready != 2 || notReady != 2 {
		t.Fatalf("ready=%d notReady=%d", ready, notReady)
	}
	if r, n := parseEndpointSlices(`{"items":[]}`); r != 0 || n != 0 {
		t.Fatalf("empty list: %d %d", r, n)
	}
	if r, n := parseEndpointSlices("not json"); r != 0 || n != 0 {
		t.Fatalf("bad json: %d %d", r, n)
	}
}
