package k8s

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/duration"

	servicerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/service"
)

// The AI chat's k8s_get_resources table (ai-service formatters.py) is drawn in Python from the objects kubectl lists, so
// the rules live twice. Go writes random objects and what kubectl and the lists print for them;
// test_kubectl_table_cases.py draws the table over the same objects. UPDATE_AI_TABLE_CASES=1 writes the file; otherwise
// this test fails when the file is not what the code gives now.
const aiTableCasesFile = "../../../ai-service/tests/fixtures/kubectl_table_cases.json"

type aiTablePodCase struct {
	Pod      *corev1.Pod `json:"pod"`
	Status   string      `json:"status"`
	Ready    string      `json:"ready"`
	Restarts int32       `json:"restarts"`
}

type aiTableServiceCase struct {
	Service    *corev1.Service `json:"service"`
	ClusterIP  string          `json:"cluster_ip"`
	ExternalIP string          `json:"external_ip"`
	Ports      string          `json:"ports"`
}

type aiTableNodeCase struct {
	Node   *corev1.Node `json:"node"`
	Status string       `json:"status"`
	Roles  string       `json:"roles"`
}

type aiTableAgeCase struct {
	Seconds int    `json:"seconds"`
	Age     string `json:"age"`
}

type aiTableCases struct {
	Pods     []aiTablePodCase     `json:"pods"`
	Services []aiTableServiceCase `json:"services"`
	Nodes    []aiTableNodeCase    `json:"nodes"`
	Ages     []aiTableAgeCase     `json:"ages"`
}

// CLUSTER-IP and PORT(S) as printService (k8s.io/kubernetes v1.37 pkg/printers/internalversion/printers.go) prints them.
func kubectlServiceCells(svc *corev1.Service) (clusterIP, ports string) {
	clusterIP = "<none>"
	if len(svc.Spec.ClusterIPs) > 0 {
		clusterIP = svc.Spec.ClusterIPs[0]
	}
	pieces := make([]string, 0, len(svc.Spec.Ports))
	for _, p := range svc.Spec.Ports {
		piece := fmt.Sprintf("%d/%s", p.Port, p.Protocol)
		if p.NodePort > 0 {
			piece = fmt.Sprintf("%d:%d/%s", p.Port, p.NodePort, p.Protocol)
		}
		pieces = append(pieces, piece)
	}
	ports = strings.Join(pieces, ",")
	if ports == "" {
		ports = "<none>"
	}
	return clusterIP, ports
}

// ROLES as printNode's findNodeRoles (the same file) prints them.
func kubectlNodeRoles(node *corev1.Node) string {
	roles := []string{}
	for k, v := range node.Labels {
		switch {
		case strings.HasPrefix(k, "node-role.kubernetes.io/"):
			if role := strings.TrimPrefix(k, "node-role.kubernetes.io/"); role != "" {
				roles = append(roles, role)
			}
		case k == "kubernetes.io/role" && v != "":
			roles = append(roles, v)
		}
	}
	slices.Sort(roles)
	roles = slices.Compact(roles)
	if len(roles) == 0 {
		return "<none>"
	}
	return strings.Join(roles, ",")
}

func randomTableNode(rng *rand.Rand, i int) *corev1.Node {
	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("n-%04d", i), Labels: map[string]string{"kubernetes.io/os": "linux"}}}
	node.Status.NodeInfo.KubeletVersion = "v1.37.2"
	node.Spec.Unschedulable = rng.Intn(2) == 0
	node.Status.Conditions = []corev1.NodeCondition{{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionFalse}}
	if ready := []corev1.ConditionStatus{corev1.ConditionTrue, corev1.ConditionFalse, corev1.ConditionUnknown, ""}[rng.Intn(4)]; ready != "" {
		node.Status.Conditions = append(node.Status.Conditions, corev1.NodeCondition{Type: corev1.NodeReady, Status: ready})
	}
	for _, label := range []string{"node-role.kubernetes.io/worker", "node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/"} {
		if rng.Intn(3) == 0 {
			node.Labels[label] = ""
		}
	}
	switch rng.Intn(4) {
	case 0:
		node.Labels["kubernetes.io/role"] = "gpu"
	case 1:
		node.Labels["kubernetes.io/role"] = "worker"
	case 2:
		node.Labels["kubernetes.io/role"] = ""
	}
	return node
}

// The seconds on each side of HumanDuration's turns, and some between them.
func tableAgeSeconds(rng *rand.Rand) []int {
	const minute, hour, day, year = 60, 3600, 86400, 365 * 86400
	turns := []int{-2, -1, 0, 1, 59, 60, 2 * minute, 10 * minute, 3 * hour, 8 * hour, 2 * day, 8 * day, 2 * year, 8 * year}
	seconds := []int{5*minute + 10, 5 * hour, 70 * minute, 49 * hour, 367 * day, 2*year + day}
	for _, t := range turns {
		seconds = append(seconds, t-1, t, t+1)
	}
	for range 60 {
		seconds = append(seconds, rng.Intn(9*year))
	}
	return seconds
}

func randomTableService(rng *rand.Rand, i int) *corev1.Service {
	types := []corev1.ServiceType{corev1.ServiceTypeClusterIP, corev1.ServiceTypeNodePort, corev1.ServiceTypeLoadBalancer, corev1.ServiceTypeExternalName, ""}
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Namespace: "ns", Name: fmt.Sprintf("s-%04d", i)},
		Spec:       corev1.ServiceSpec{Type: types[rng.Intn(len(types))]},
	}
	if rng.Intn(2) == 0 {
		svc.Spec.ExternalName = "db.example.test"
	}
	// as the API server writes them: an ExternalName has neither, a headless Service says None in both
	if svc.Spec.Type != corev1.ServiceTypeExternalName {
		switch rng.Intn(3) {
		case 0:
			svc.Spec.ClusterIPs = []string{"10.0.0.1"}
		case 1:
			svc.Spec.ClusterIPs = []string{"fd00::1", "10.0.0.2"}
		case 2:
			svc.Spec.ClusterIPs = []string{corev1.ClusterIPNone}
		}
		svc.Spec.ClusterIP = svc.Spec.ClusterIPs[0]
		for n := rng.Intn(3); n > 0; n-- {
			port := corev1.ServicePort{Port: int32(80 + n), Protocol: []corev1.Protocol{corev1.ProtocolTCP, corev1.ProtocolUDP}[rng.Intn(2)]}
			if rng.Intn(2) == 0 {
				port.NodePort = int32(30000 + n)
			}
			svc.Spec.Ports = append(svc.Spec.Ports, port)
		}
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
	return svc
}

func aiTableCaseSet() aiTableCases {
	pods := rand.New(rand.NewSource(23))
	services := rand.New(rand.NewSource(29))
	var out aiTableCases
	for i := 0; i < 400; i++ {
		p := randomPrintPod(pods, i)
		status, ready, total, restarts := podListView(p)
		out.Pods = append(out.Pods, aiTablePodCase{Pod: p, Status: status, Ready: strconv.Itoa(ready) + "/" + strconv.Itoa(total), Restarts: restarts})
	}
	for i := 0; i < 200; i++ {
		svc := randomTableService(services, i)
		clusterIP, ports := kubectlServiceCells(svc)
		out.Services = append(out.Services, aiTableServiceCase{Service: svc, ClusterIP: clusterIP, ExternalIP: servicerow.Info(svc)["external_ip"].(string), Ports: ports})
	}
	nodes := rand.New(rand.NewSource(31))
	for i := 0; i < 80; i++ {
		node := randomTableNode(nodes, i)
		out.Nodes = append(out.Nodes, aiTableNodeCase{Node: node, Status: nodeStatusText(node), Roles: kubectlNodeRoles(node)})
	}
	for _, s := range tableAgeSeconds(rand.New(rand.NewSource(37))) {
		out.Ages = append(out.Ages, aiTableAgeCase{Seconds: s, Age: duration.HumanDuration(time.Duration(s) * time.Second)})
	}
	return out
}

func TestAITableCasesFixture(t *testing.T) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	if err := enc.Encode(aiTableCaseSet()); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_AI_TABLE_CASES") == "1" {
		if err := os.WriteFile(aiTableCasesFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	have, err := os.ReadFile(aiTableCasesFile)
	if err != nil {
		t.Fatalf("%v (UPDATE_AI_TABLE_CASES=1 writes it)", err)
	}
	if !bytes.Equal(have, buf.Bytes()) {
		t.Fatal("kubectl_table_cases.json is not what the lists give now: rerun with UPDATE_AI_TABLE_CASES=1 and run the ai-service test")
	}
}
