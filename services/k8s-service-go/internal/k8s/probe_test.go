package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const probeKubeconfigTemplate = `apiVersion: v1
kind: Config
clusters:
- name: c
  cluster:
    server: https://127.0.0.1:1
contexts:
- name: c
  context: {cluster: c, user: u}
current-context: c
users:
- name: u
  user:
    %s
`

func TestProbeKubeconfig_RejectsDisallowedExecBeforeDialing(t *testing.T) {
	execCommands = []string{"aws-iam-authenticator"}
	s := &Service{}
	blob := strings.Replace(probeKubeconfigTemplate, "%s",
		"exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: /bin/sh\n      args: [-c, id]", 1)
	start := time.Now()
	_, err := s.ProbeKubeconfig(context.Background(), blob, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("want exec allow-list error, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("allow-list check must not dial: took %s", time.Since(start))
	}
}

// A password in a server address the client cannot use stays out of the text, which reaches a stored audit row.
func TestProbeKubeconfig_SaysAServerAddressIsBadWithoutQuotingIt(t *testing.T) {
	const value = "fake-pass-1"
	for name, server := range map[string]string{
		"a space in the host": "https://bob:" + value + "@ex ample:6443",
		"a broken escape":     "http://%zz" + value,
	} {
		t.Run(name, func(t *testing.T) {
			s := &Service{}
			blob := strings.Replace(strings.Replace(probeKubeconfigTemplate, "%s", "token: abc", 1), "https://127.0.0.1:1", `"`+server+`"`, 1)
			_, err := s.ProbeKubeconfig(context.Background(), blob, 3*time.Second)
			if err == nil {
				t.Fatal("not refused")
			}
			if strings.Contains(err.Error(), value) {
				t.Errorf("the value is in the text: %v", err)
			}
			if !strings.Contains(err.Error(), "create client") {
				t.Errorf("the text does not say where it failed: %v", err)
			}
		})
	}
}

// The cluster UID that refuses one cluster registered twice is read with the kubeconfig's own credential, as itself:
// get on the kube-system Namespace is enough, and a credential refused that get still connects, with no UID.
func TestProbeKubeconfig_ReadsTheKubeSystemUIDWithOnlyThatGet(t *testing.T) {
	for name, tc := range map[string]struct {
		mayGet bool
		want   string
	}{
		"get on kube-system": {mayGet: true, want: "kube-system-uid-1"},
		"no get":             {mayGet: false, want: ""},
	} {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var asked []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				asked = append(asked, r.Method+" "+r.URL.Path)
				mu.Unlock()
				if v := r.Header.Get("Impersonate-User"); v != "" {
					t.Errorf("%s went as %q", r.URL.Path, v)
				}
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/version":
					_, _ = w.Write([]byte(`{"major":"1","minor":"37","gitVersion":"v1.37.0"}`))
				case r.Method == http.MethodGet && r.URL.Path == "/api/v1/namespaces/kube-system" && tc.mayGet:
					_, _ = w.Write([]byte(`{"kind":"Namespace","apiVersion":"v1","metadata":{"name":"kube-system","uid":"kube-system-uid-1"}}`))
				default:
					w.WriteHeader(http.StatusForbidden)
					_, _ = w.Write([]byte(`{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}`))
				}
			}))
			defer srv.Close()
			blob := strings.Replace(strings.Replace(probeKubeconfigTemplate, "%s", "token: abc", 1), "https://127.0.0.1:1", srv.URL, 1)

			res, err := (&Service{}).ProbeKubeconfig(context.Background(), blob, 3*time.Second)
			if err != nil {
				t.Fatalf("the probe failed: %v", err)
			}
			if res.UID != tc.want {
				t.Errorf("UID = %q, want %q", res.UID, tc.want)
			}
			if res.Version != "v1.37.0" || res.Server != srv.URL {
				t.Errorf("version %q, server %q", res.Version, res.Server)
			}
			mu.Lock()
			defer mu.Unlock()
			if want := []string{"GET /version", "GET /api/v1/namespaces/kube-system"}; strings.Join(asked, ", ") != strings.Join(want, ", ") {
				t.Errorf("asked %v, want %v", asked, want)
			}
		})
	}
}

func TestProbeKubeconfig_ReportsConnectionFailure(t *testing.T) {
	s := &Service{}
	blob := strings.Replace(probeKubeconfigTemplate, "%s", "token: abc", 1)
	_, err := s.ProbeKubeconfig(context.Background(), blob, 3*time.Second)
	if err == nil || !strings.Contains(err.Error(), "connection failed") {
		t.Fatalf("want connection failure against a closed port, got %v", err)
	}
}
