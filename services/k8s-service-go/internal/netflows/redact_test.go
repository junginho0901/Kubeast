package netflows

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// A peer outside the reader's namespaces is shown by namespace and address only. A DNS name seen for it says what its
// pod and Service names would, so it goes with them; a name of an address no namespace owns, or of the reader's own, stays.
func TestKeepHidesTheDNSNamesOfAPeerOutsideTheScope(t *testing.T) {
	now := time.Date(2026, 11, 7, 4, 0, 0, 0, time.UTC)
	const name, ip = "db.ops.example", "10.0.0.9"
	names := []string{name}
	for _, c := range []struct {
		title    string
		peer     End
		want     End
		redacted bool
	}{
		{"a pod of another namespace",
			End{Namespace: "ops", Pod: "db-1", IP: ip, Port: 5432, Names: names, Identity: 7},
			End{Namespace: "ops", IP: ip, Port: 5432}, true},
		{"another namespace with nothing but its names",
			End{Namespace: "ops", IP: ip, Names: names},
			End{Namespace: "ops", IP: ip}, true},
		{"no namespace, the Service of another namespace",
			End{IP: ip, Service: "ops/db", Names: names},
			End{IP: ip}, true},
		{"no namespace, a Service naming no namespace",
			End{IP: ip, Service: "db", Names: names},
			End{IP: ip}, true},
		{"the reader's pod behind another namespace's Service",
			End{Namespace: "shop", Pod: "web-1", IP: ip, Service: "ops/db", Names: names},
			End{Namespace: "shop", Pod: "web-1", IP: ip}, true},
		{"the reader's own pod",
			End{Namespace: "shop", Pod: "web-1", IP: ip, Names: names},
			End{Namespace: "shop", Pod: "web-1", IP: ip, Names: names}, false},
		{"the reader's own Service",
			End{IP: ip, Service: "shop/web", Names: names},
			End{IP: ip, Service: "shop/web", Names: names}, false},
		{"an address outside the cluster",
			End{IP: "93.184.216.34", Names: []string{"example.com"}},
			End{IP: "93.184.216.34", Names: []string{"example.com"}}, false},
	} {
		t.Run(c.title, func(t *testing.T) {
			s := testStore()
			req := Request{Namespace: "shop", Scope: []string{"shop"}}
			if err := s.Normalize(&req); err != nil {
				t.Fatal(err)
			}
			flow := Flow{Time: now.Add(-time.Minute), Verdict: "FORWARDED", Source: End{Namespace: "shop", Pod: "api-1"}, Destination: c.peer}
			res := s.keep(context.Background(), req, []Flow{flow}, now, false)
			if len(res.Flows) != 1 {
				t.Fatalf("flows %+v", res.Flows)
			}
			if got := res.Flows[0].Destination; !reflect.DeepEqual(got, c.want) {
				t.Errorf("destination = %+v, want %+v", got, c.want)
			}
			if res.Redacted != c.redacted {
				t.Errorf("redacted = %v, want %v", res.Redacted, c.redacted)
			}
			answer, err := json.Marshal(res)
			if err != nil {
				t.Fatal(err)
			}
			if hidden := len(c.want.Names) == 0; hidden && strings.Contains(string(answer), name) {
				t.Errorf("the answer names the hidden peer: %s", answer)
			}
		})
	}
}

// Without a scope nothing is hidden: the names stay for a reader of the whole cluster.
func TestKeepLeavesTheNamesToAReaderOfTheWholeCluster(t *testing.T) {
	now := time.Date(2026, 11, 7, 4, 0, 0, 0, time.UTC)
	s := testStore()
	req := Request{Namespace: "shop"}
	if err := s.Normalize(&req); err != nil {
		t.Fatal(err)
	}
	peer := End{Namespace: "ops", Pod: "db-1", Names: []string{"db.ops.example"}}
	res := s.keep(context.Background(), req, []Flow{{Time: now.Add(-time.Minute), Verdict: "FORWARDED", Source: End{Namespace: "shop", Pod: "api-1"}, Destination: peer}}, now, false)
	if len(res.Flows) != 1 || res.Redacted || !reflect.DeepEqual(res.Flows[0].Destination, peer) {
		t.Fatalf("no scope: %+v", res)
	}
}

// Every field of an end is what a hidden peer keeps or what redact empties, so a new field has to say which.
func TestRedactLeavesAHiddenPeerItsNamespaceAndAddressOnly(t *testing.T) {
	kept := map[string]bool{"Namespace": true, "IP": true, "Port": true, "ServiceAddress": true}
	end := End{}
	v := reflect.ValueOf(&end).Elem()
	for i := 0; i < v.NumField(); i++ {
		switch f := v.Field(i); f.Kind() {
		case reflect.String:
			f.SetString("x")
		case reflect.Uint32:
			f.SetUint(1)
		case reflect.Bool:
			f.SetBool(true)
		case reflect.Slice:
			f.Set(reflect.ValueOf([]string{"x"}))
		case reflect.Ptr:
			f.Set(reflect.New(f.Type().Elem()))
		default:
			t.Fatalf("set field %s of kind %s", v.Type().Field(i).Name, f.Kind())
		}
	}
	end.Namespace, end.Service = "ops", "ops/db"
	req := Request{Namespace: "shop", Scope: []string{"shop"}}
	if !req.redact(&end) {
		t.Fatal("a peer of another namespace was not hidden")
	}
	for i := 0; i < v.NumField(); i++ {
		name := v.Type().Field(i).Name
		if set := !v.Field(i).IsZero(); set != kept[name] {
			t.Errorf("%s after hiding: set = %v, want %v (%+v)", name, set, kept[name], end)
		}
	}
}
