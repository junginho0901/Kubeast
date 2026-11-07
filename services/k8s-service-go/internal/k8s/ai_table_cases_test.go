package k8s

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	servicerow "github.com/junginho0901/kubeast/services/k8s-service-go/internal/service"
)

// The AI chat's k8s_get_resources table (ai-service formatters.py) is drawn in Python from the objects kubectl lists, so
// the rules live twice. Go writes random objects and what the Pods and Services lists show for them;
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
	ExternalIP string          `json:"external_ip"`
}

type aiTableCases struct {
	Pods     []aiTablePodCase     `json:"pods"`
	Services []aiTableServiceCase `json:"services"`
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
		out.Services = append(out.Services, aiTableServiceCase{Service: svc, ExternalIP: servicerow.Info(svc)["external_ip"].(string)})
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
