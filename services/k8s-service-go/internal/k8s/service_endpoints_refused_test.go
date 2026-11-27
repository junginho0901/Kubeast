package k8s

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// A Service's details whose EndpointSlices could not be read say why and hold no endpoints, instead of none.
func TestDescribeServiceSaysWhyItsEndpointsWereNotRead(t *testing.T) {
	answer := func(refused ...string) map[string]interface{} {
		t.Helper()
		out, err := refusingAPI(t, refused...).DescribeService(context.Background(), "a", "web")
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	out := answer("a/endpointslices")
	if why, _ := out["endpoints_error"].(string); !strings.Contains(why, `endpointslices is forbidden in the namespace "a"`) {
		t.Errorf("endpoints_error %#v", out["endpoints_error"])
	}
	for _, key := range []string{"endpoints", "endpoint_slices", "endpoint_summary"} {
		if v, ok := out[key]; ok {
			t.Errorf("%s of slices that were not read: %v", key, v)
		}
	}

	// read and there are none: the lists, empty
	out = answer()
	raw, _ := json.Marshal(map[string]interface{}{"endpoints": out["endpoints"], "endpoint_slices": out["endpoint_slices"], "error": out["endpoints_error"]})
	if string(raw) != `{"endpoint_slices":[],"endpoints":[],"error":null}` {
		t.Errorf("none: %s", raw)
	}
}
