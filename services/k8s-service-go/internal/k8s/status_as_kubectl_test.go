package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// oneObjectAPI answers the object at each path and an empty list for anything else a describe reads beside it.
func oneObjectAPI(t *testing.T, objects map[string]string) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if body, ok := objects[r.URL.Path]; ok {
			_, _ = w.Write([]byte(body))
			return
		}
		_, _ = w.Write([]byte(`{"kind":"List","apiVersion":"v1","metadata":{},"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: 1000, Burst: 1000})
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	s.defaultBundle.Store(&clientBundle{clientset: cs})
	return s
}

// A Job's drawer and its CronJob's Jobs table say what the Jobs list says, as kubectl's printJob words it.
func TestAJobReadsTheSameInItsListDrawerAndCronJob(t *testing.T) {
	const gone = `,"deletionTimestamp":"2026-11-06T12:00:00Z"`
	condition := func(kind string) string {
		return `"status":{"conditions":[{"type":"` + kind + `","status":"True"}]}`
	}
	cases := []struct {
		want, meta, status string
	}{
		{"Running", "", `"status":{"active":1}`},
		{"Complete", "", condition("Complete")},
		{"Failed", "", condition("Failed")},
		{"Terminating", gone, `"status":{"active":1}`},
		{"Suspended", "", condition("Suspended")},
		{"FailureTarget", "", condition("FailureTarget")},
		{"SuccessCriteriaMet", "", condition("SuccessCriteriaMet")},
	}
	for _, c := range cases {
		job := `{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"x","namespace":"ns"` + c.meta +
			`,"ownerReferences":[{"apiVersion":"batch/v1","kind":"CronJob","name":"daily","uid":"u-1","controller":true}]},"spec":{"template":{"spec":{"containers":[{"name":"app","image":"example.test/app:1"}]}}},` + c.status + `}`
		s := oneObjectAPI(t, map[string]string{
			"/apis/batch/v1/namespaces/ns/jobs/x": job,
			"/apis/batch/v1/namespaces/ns/jobs":   fmt.Sprintf(`{"kind":"JobList","apiVersion":"batch/v1","metadata":{},"items":[%s]}`, job),
		})
		ctx := context.Background()
		listed, err := s.GetJobs(ctx, "ns")
		if err != nil || len(listed) != 1 {
			t.Fatalf("%s: list %v, %v", c.want, listed, err)
		}
		if got := listed[0]["status"]; got != c.want {
			t.Errorf("%s: the list says %q", c.want, got)
		}
		described, err := s.DescribeJob(ctx, "ns", "x")
		if err != nil {
			t.Fatal(err)
		}
		if got := described["status"]; got != c.want {
			t.Errorf("%s: the drawer says %q", c.want, got)
		}
		owned, err := s.GetCronJobOwnedJobs(ctx, "ns", "daily")
		if err != nil || len(owned) != 1 {
			t.Fatalf("%s: owned %v, %v", c.want, owned, err)
		}
		if got := owned[0]["status"]; got != c.want {
			t.Errorf("%s: the CronJob's Jobs table says %q", c.want, got)
		}
	}
}

// The describe answer keeps what the row keeps: the spec's external IPs and the load balancer's addresses, each empty
// when there are none, so the drawer never falls back on the External IP cell.
func TestAServiceDrawerReadsExternalIPsAndTheLoadBalancerApart(t *testing.T) {
	cases := []struct {
		name, spec, status, wantCell, wantIPs, wantIngress string
	}{
		{"pending", `"type":"LoadBalancer"`, `{}`, "<pending>", `[]`, `[]`},
		{"ExternalName", `"type":"ExternalName","externalName":"db.example.test"`, `{}`, "db.example.test", `[]`, `[]`},
		{"plain", `"type":"ClusterIP"`, `{}`, "<none>", `[]`, `[]`},
		{"both", `"type":"LoadBalancer","externalIPs":["192.0.2.9"]`, `{"ingress":[{"ip":"192.0.2.1"},{"hostname":"lb.example.test"}]}`,
			"192.0.2.1,lb.example.test,192.0.2.9", `["192.0.2.9"]`, `[{"ip":"192.0.2.1"},{"hostname":"lb.example.test"}]`},
	}
	for _, c := range cases {
		s := oneObjectAPI(t, map[string]string{
			"/api/v1/namespaces/ns/services/x": `{"apiVersion":"v1","kind":"Service","metadata":{"name":"x","namespace":"ns"},"spec":{` + c.spec + `},"status":{"loadBalancer":` + c.status + `}}`,
		})
		out, err := s.DescribeService(context.Background(), "ns", "x")
		if err != nil {
			t.Fatal(err)
		}
		if out["external_ip"] != c.wantCell {
			t.Errorf("%s: external_ip %q, want %q", c.name, out["external_ip"], c.wantCell)
		}
		ips, _ := json.Marshal(out["external_ips"])
		ingress, _ := json.Marshal(out["load_balancer_ingress"])
		if strings.TrimSpace(string(ips)) != c.wantIPs {
			t.Errorf("%s: external_ips %s, want %s", c.name, ips, c.wantIPs)
		}
		if strings.TrimSpace(string(ingress)) != c.wantIngress {
			t.Errorf("%s: load_balancer_ingress %s, want %s", c.name, ingress, c.wantIngress)
		}
	}
}
