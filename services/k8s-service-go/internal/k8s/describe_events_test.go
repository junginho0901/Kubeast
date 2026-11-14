package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// setEvents gives a drawer the events newest first, an empty list when there are none (the drawer's "None"), and the
// reason without a list when they could not be listed.
func TestSetEvents(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	listed := &corev1.EventList{Items: []corev1.Event{
		gatewayEvent("ns", "Pod", "p", "Old", now.Add(-time.Hour)),
		gatewayEvent("ns", "Pod", "p", "New", now),
	}}
	out := map[string]interface{}{}
	setEvents(out, listed, nil, about())
	if got := reasons(out); !reflect.DeepEqual(got, []string{"New", "Old"}) || out["events_error"] != nil {
		t.Errorf("listed: events %v, events_error %#v", got, out["events_error"])
	}

	out = map[string]interface{}{}
	setEvents(out, &corev1.EventList{}, nil, about())
	if raw, _ := json.Marshal(out); string(raw) != `{"events":[]}` {
		t.Errorf("none: %s, want an empty list", raw)
	}

	out = map[string]interface{}{"events": []map[string]interface{}{}}
	setEvents(out, nil, errors.New(`events is forbidden: User "u" cannot list resource "events"`), about())
	if raw, _ := json.Marshal(out); string(raw) != `{"events_error":"events is forbidden: User \"u\" cannot list resource \"events\""}` {
		t.Errorf("refused: %s, want the reason and no list", raw)
	}

	// a 403 whose Status has no message: client-go's error text is empty
	out = map[string]interface{}{}
	setEvents(out, nil, &apierrors.StatusError{ErrStatus: metav1.Status{Status: metav1.StatusFailure, Reason: metav1.StatusReasonForbidden, Code: 403}}, about())
	if out["events_error"] != "events could not be listed: Forbidden" {
		t.Errorf("refused without a message: events_error %#v", out["events_error"])
	}

	out = map[string]interface{}{}
	setEvents(out, nil, nil, about())
	checkEventsRefused(t, out)
}

// Every describe answer gets its events through setEvents: an answer that put an empty list in place of a refused one
// made its drawer say "None" for events it never read, and one that left the key out hid the section (11-04).
func TestDescribeEvents_ThroughSetEvents(t *testing.T) {
	bypass := regexp.MustCompile(`\[\s*"events"\s*\]\s*=|"events":\s|&corev1\.EventList\{\}|formatEventList\(`)
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || f == "workloads_formatters.go" {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, loc := range bypass.FindAllIndex(b, -1) {
			// the node events API answers its list, or its error to the handler
			if f == "nodes.go" && strings.HasPrefix(string(b[loc[0]:]), "formatEventList(items), nil") {
				continue
			}
			line := strings.Count(string(b[:loc[0]]), "\n") + 1
			t.Errorf("%s:%d writes a describe's events without setEvents: %s", f, line, b[loc[0]:loc[1]])
		}
	}
}

// eventsProbeAPI answers every events list with no events, or 403 when refused, and any other GET with an empty
// object that is also an empty list, so each describe below reads its object and the lists it needs.
type eventsProbeAPI struct{ refuse bool }

func (a *eventsProbeAPI) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if strings.HasSuffix(r.URL.Path, "/events") {
		if a.refuse {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403,"message":"events is forbidden"}`))
			return
		}
		_, _ = w.Write([]byte(`{"kind":"EventList","apiVersion":"v1","metadata":{},"items":[]}`))
		return
	}
	_, _ = w.Write([]byte(`{"metadata":{"name":"x","namespace":"ns"},"items":[]}`))
}

// The drawers that hid their Events section when the answer had none, and the others read through the typed client:
// with events listed but none, the answer has an empty list (the drawer's "None"); refused, the reason and no list.
func TestDescribe_EventsNoneOrWhyNot(t *testing.T) {
	ctx := context.Background()
	describes := map[string]func(s *Service) (map[string]interface{}, error){
		"Pod":                     func(s *Service) (map[string]interface{}, error) { return s.DescribePod(ctx, "ns", "x") },
		"Deployment":              func(s *Service) (map[string]interface{}, error) { return s.DescribeDeployment(ctx, "ns", "x") },
		"StatefulSet":             func(s *Service) (map[string]interface{}, error) { return s.DescribeStatefulSet(ctx, "ns", "x") },
		"DaemonSet":               func(s *Service) (map[string]interface{}, error) { return s.DescribeDaemonSet(ctx, "ns", "x") },
		"ReplicaSet":              func(s *Service) (map[string]interface{}, error) { return s.DescribeReplicaSet(ctx, "ns", "x") },
		"Job":                     func(s *Service) (map[string]interface{}, error) { return s.DescribeJob(ctx, "ns", "x") },
		"CronJob":                 func(s *Service) (map[string]interface{}, error) { return s.DescribeCronJob(ctx, "ns", "x") },
		"Service":                 func(s *Service) (map[string]interface{}, error) { return s.DescribeService(ctx, "ns", "x") },
		"ConfigMap":               func(s *Service) (map[string]interface{}, error) { return s.DescribeConfigMap(ctx, "ns", "x") },
		"Secret":                  func(s *Service) (map[string]interface{}, error) { return s.DescribeSecret(ctx, "ns", "x", false) },
		"ServiceAccount":          func(s *Service) (map[string]interface{}, error) { return s.DescribeServiceAccount(ctx, "ns", "x") },
		"Role":                    func(s *Service) (map[string]interface{}, error) { return s.DescribeRole(ctx, "ns", "x") },
		"RoleBinding":             func(s *Service) (map[string]interface{}, error) { return s.DescribeRoleBinding(ctx, "ns", "x") },
		"Endpoints":               func(s *Service) (map[string]interface{}, error) { return s.DescribeEndpoints(ctx, "ns", "x") },
		"Ingress":                 func(s *Service) (map[string]interface{}, error) { return s.DescribeIngress(ctx, "ns", "x") },
		"IngressClass":            func(s *Service) (map[string]interface{}, error) { return s.DescribeIngressClass(ctx, "x") },
		"NetworkPolicy":           func(s *Service) (map[string]interface{}, error) { return s.DescribeNetworkPolicy(ctx, "ns", "x") },
		"EndpointSlice":           func(s *Service) (map[string]interface{}, error) { return s.DescribeEndpointSlice(ctx, "ns", "x") },
		"PersistentVolume":        func(s *Service) (map[string]interface{}, error) { return s.DescribePV(ctx, "x") },
		"PersistentVolumeClaim":   func(s *Service) (map[string]interface{}, error) { return s.DescribePVC(ctx, "ns", "x") },
		"StorageClass":            func(s *Service) (map[string]interface{}, error) { return s.DescribeStorageClass(ctx, "x") },
		"VolumeAttachment":        func(s *Service) (map[string]interface{}, error) { return s.DescribeVolumeAttachment(ctx, "x") },
		"Namespace":               func(s *Service) (map[string]interface{}, error) { return s.DescribeNamespace(ctx, "x") },
		"Node":                    func(s *Service) (map[string]interface{}, error) { return s.DescribeNode(ctx, "x") },
		"HorizontalPodAutoscaler": func(s *Service) (map[string]interface{}, error) { return s.DescribeHPA(ctx, "ns", "x") },
		"PodDisruptionBudget":     func(s *Service) (map[string]interface{}, error) { return s.DescribePDB(ctx, "ns", "x") },
		"ResourceQuota":           func(s *Service) (map[string]interface{}, error) { return s.DescribeResourceQuota(ctx, "ns", "x") },
		"LimitRange":              func(s *Service) (map[string]interface{}, error) { return s.DescribeLimitRange(ctx, "ns", "x") },
		"Lease":                   func(s *Service) (map[string]interface{}, error) { return s.DescribeLease(ctx, "ns", "x") },
		"PriorityClass":           func(s *Service) (map[string]interface{}, error) { return s.DescribePriorityClass(ctx, "x") },
		"RuntimeClass":            func(s *Service) (map[string]interface{}, error) { return s.DescribeRuntimeClass(ctx, "x") },
		"ClusterRole":             func(s *Service) (map[string]interface{}, error) { return s.DescribeClusterRole(ctx, "x") },
		"ClusterRoleBinding":      func(s *Service) (map[string]interface{}, error) { return s.DescribeClusterRoleBinding(ctx, "x") },
		"MutatingWebhookConfiguration": func(s *Service) (map[string]interface{}, error) {
			return s.DescribeMutatingWebhookConfiguration(ctx, "x")
		},
		"ValidatingWebhookConfiguration": func(s *Service) (map[string]interface{}, error) {
			return s.DescribeValidatingWebhookConfiguration(ctx, "x")
		},
		"ValidatingAdmissionPolicy": func(s *Service) (map[string]interface{}, error) { return s.DescribeValidatingAdmissionPolicy(ctx, "x") },
		"MutatingAdmissionPolicy":   func(s *Service) (map[string]interface{}, error) { return s.DescribeMutatingAdmissionPolicy(ctx, "x") },
	}
	for _, refuse := range []bool{false, true} {
		api := &eventsProbeAPI{refuse: refuse}
		srv := httptest.NewServer(http.HandlerFunc(api.serve))
		cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL, QPS: 1000, Burst: 1000})
		if err != nil {
			t.Fatal(err)
		}
		s := &Service{}
		s.defaultBundle.Store(&clientBundle{clientset: cs})
		for kind, describe := range describes {
			out, err := describe(s)
			if err != nil {
				t.Errorf("%s (refused=%v): %v", kind, refuse, err)
				continue
			}
			wire, _ := asWire(out).(map[string]interface{})
			if refuse {
				if _, has := wire["events"]; has || wire["events_error"] != "events is forbidden" {
					t.Errorf("%s refused: events %#v, events_error %#v — want the reason and no list", kind, wire["events"], wire["events_error"])
				}
				continue
			}
			if list, ok := wire["events"].([]interface{}); !ok || len(list) != 0 || wire["events_error"] != nil {
				t.Errorf("%s with no events: events %#v, events_error %#v — want an empty list", kind, wire["events"], wire["events_error"])
			}
		}
		srv.Close()
	}
}
