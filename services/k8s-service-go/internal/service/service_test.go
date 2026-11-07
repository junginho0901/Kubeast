package service

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/sets"
)

// kubectlExternalIP is getServiceExternalIP with loadBalancerStatusStringer of Kubernetes v1.37.2
// (pkg/printers/internalversion/printers.go, Apache-2.0), over the public API's types. Wide is always on, as the API
// server builds the table kubectl prints (pkg/printers/storage/storage.go), so no address is clipped.
func kubectlExternalIP(svc *corev1.Service) string {
	switch svc.Spec.Type {
	case corev1.ServiceTypeClusterIP:
		if len(svc.Spec.ExternalIPs) > 0 {
			return strings.Join(svc.Spec.ExternalIPs, ",")
		}
		return "<none>"
	case corev1.ServiceTypeNodePort:
		if len(svc.Spec.ExternalIPs) > 0 {
			return strings.Join(svc.Spec.ExternalIPs, ",")
		}
		return "<none>"
	case corev1.ServiceTypeLoadBalancer:
		lbIps := kubectlLoadBalancerStatus(svc.Status.LoadBalancer)
		if len(svc.Spec.ExternalIPs) > 0 {
			results := []string{}
			if len(lbIps) > 0 {
				results = append(results, strings.Split(lbIps, ",")...)
			}
			results = append(results, svc.Spec.ExternalIPs...)
			return strings.Join(results, ",")
		}
		if len(lbIps) > 0 {
			return lbIps
		}
		return "<pending>"
	case corev1.ServiceTypeExternalName:
		return svc.Spec.ExternalName
	}
	return "<unknown>"
}

func kubectlLoadBalancerStatus(s corev1.LoadBalancerStatus) string {
	ingress := s.Ingress
	result := sets.NewString()
	for i := range ingress {
		if ingress[i].IP != "" {
			result.Insert(ingress[i].IP)
		} else if ingress[i].Hostname != "" {
			result.Insert(ingress[i].Hostname)
		}
	}
	return strings.Join(result.List(), ",")
}

func lbService(ingress []corev1.LoadBalancerIngress, externalIPs ...string) *corev1.Service {
	return &corev1.Service{
		Spec:   corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer, ExternalIPs: externalIPs},
		Status: corev1.ServiceStatus{LoadBalancer: corev1.LoadBalancerStatus{Ingress: ingress}},
	}
}

// Written out by hand: a port of kubectl's function that went wrong would pass the sweep below.
func TestExternalIPReadsAsKubectlPrintsIt(t *testing.T) {
	longName := "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6-1234567890.ap-northeast-2.elb.amazonaws.com"
	cases := []struct {
		name string
		svc  *corev1.Service
		want string
	}{
		{"ClusterIP with none", &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP}}, "<none>"},
		{"ClusterIP with external IPs", &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP, ExternalIPs: []string{"192.0.2.9", "192.0.2.1"}}}, "192.0.2.9,192.0.2.1"},
		{"NodePort with none", &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeNodePort}}, "<none>"},
		{"NodePort with external IPs", &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeNodePort, ExternalIPs: []string{"192.0.2.9"}}}, "192.0.2.9"},
		{"ClusterIP ignores a load balancer status left behind", &corev1.Service{
			Spec:   corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP},
			Status: corev1.ServiceStatus{LoadBalancer: corev1.LoadBalancerStatus{Ingress: []corev1.LoadBalancerIngress{{IP: "192.0.2.1"}}}},
		}, "<none>"},
		{"LoadBalancer that has no address yet", lbService(nil), "<pending>"},
		{"LoadBalancer with an IP", lbService([]corev1.LoadBalancerIngress{{IP: "192.0.2.1"}}), "192.0.2.1"},
		{"LoadBalancer with a long hostname, not clipped", lbService([]corev1.LoadBalancerIngress{{Hostname: longName}}), longName},
		{"LoadBalancer entry with an IP and a hostname prints the IP", lbService([]corev1.LoadBalancerIngress{{IP: "192.0.2.1", Hostname: "lb.example.test"}}), "192.0.2.1"},
		{"LoadBalancer addresses sorted, each once", lbService([]corev1.LoadBalancerIngress{{IP: "192.0.2.9"}, {Hostname: "lb.example.test"}, {IP: "192.0.2.1"}, {IP: "192.0.2.9"}}), "192.0.2.1,192.0.2.9,lb.example.test"},
		{"LoadBalancer addresses come before external IPs", lbService([]corev1.LoadBalancerIngress{{IP: "192.0.2.1"}, {Hostname: "lb.example.test"}}, "192.0.2.9"), "192.0.2.1,lb.example.test,192.0.2.9"},
		{"LoadBalancer with no address and external IPs is not pending", lbService(nil, "192.0.2.9"), "192.0.2.9"},
		{"ExternalName prints its name", &corev1.Service{Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeExternalName, ExternalName: "db.example.test"}}, "db.example.test"},
		{"a type kubectl does not know", &corev1.Service{}, "<unknown>"},
	}
	for _, c := range cases {
		if got := Info(c.svc)["external_ip"]; got != c.want {
			t.Errorf("%s: external_ip %q, want %q", c.name, got, c.want)
		}
		if got := kubectlExternalIP(c.svc); got != c.want {
			t.Errorf("%s: the port of kubectl's function gives %q, want %q", c.name, got, c.want)
		}
	}
}

func TestExternalIPIsKubectlsForEveryMixOfTypeAndAddress(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	types := []corev1.ServiceType{corev1.ServiceTypeClusterIP, corev1.ServiceTypeNodePort, corev1.ServiceTypeLoadBalancer, corev1.ServiceTypeExternalName, ""}
	for i := 0; i < 3000; i++ {
		svc := &corev1.Service{Spec: corev1.ServiceSpec{Type: types[rng.Intn(len(types))]}}
		if rng.Intn(2) == 0 {
			svc.Spec.ExternalName = "db.example.test"
		}
		for n := rng.Intn(3); n > 0; n-- {
			svc.Spec.ExternalIPs = append(svc.Spec.ExternalIPs, fmt.Sprintf("192.0.2.%d", rng.Intn(5)))
		}
		for n := rng.Intn(4); n > 0; n-- {
			entry := corev1.LoadBalancerIngress{}
			if rng.Intn(3) > 0 {
				entry.IP = fmt.Sprintf("198.51.100.%d", rng.Intn(5))
			}
			if rng.Intn(3) > 0 {
				entry.Hostname = fmt.Sprintf("lb%d.example.test", rng.Intn(5))
			}
			svc.Status.LoadBalancer.Ingress = append(svc.Status.LoadBalancer.Ingress, entry)
		}
		if got, want := Info(svc)["external_ip"], kubectlExternalIP(svc); got != want {
			t.Fatalf("%+v %+v: external_ip %q, kubectl prints %q", svc.Spec, svc.Status, got, want)
		}
	}
}

// The External IP cell mixes what spec.externalIPs and the load balancer say, and for some Services is no address at
// all. The drawer opened from a row reads them apart, so the row keeps them apart.
func TestRowKeepsExternalIPsAndTheLoadBalancerApart(t *testing.T) {
	row := func(svc *corev1.Service) map[string]interface{} {
		b, err := json.Marshal(Info(svc))
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]interface{}
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	both := row(lbService([]corev1.LoadBalancerIngress{{IP: "192.0.2.1"}, {Hostname: "lb.example.test"}}, "192.0.2.9"))
	if got := fmt.Sprint(both["external_ips"]); got != "[192.0.2.9]" {
		t.Errorf("external_ips %s, want the spec's alone", got)
	}
	if got := fmt.Sprint(both["load_balancer_ingress"]); got != "[map[ip:192.0.2.1] map[hostname:lb.example.test]]" {
		t.Errorf("load_balancer_ingress %s, want the status's alone", got)
	}
	for name, svc := range map[string]*corev1.Service{
		"pending":      lbService(nil),
		"ExternalName": {Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeExternalName, ExternalName: "db.example.test"}},
		"ClusterIP":    {Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP}},
	} {
		r := row(svc)
		if got := fmt.Sprint(r["external_ips"], r["load_balancer_ingress"]); got != "[] []" {
			t.Errorf("%s: external_ips and load_balancer_ingress %s, want both empty lists", name, got)
		}
	}
}
