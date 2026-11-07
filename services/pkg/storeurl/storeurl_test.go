package storeurl

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The same addresses run in ai-service (test_model_config_policy.py), where private ranges need the list: "store" is what
// this rule answers and "model" what that one does.
func TestSharedAddressCases(t *testing.T) {
	raw, err := os.ReadFile("../../ai-service/tests/fixtures/address_forms_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Address string `json:"address"`
		Form    string `json:"form"`
		Store   string `json:"store"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases read")
	}
	namesTheSetting := func(err error) bool { return err != nil && strings.Contains(err.Error(), allowedHostsValue) }
	for _, c := range cases {
		t.Run(c.Address, func(t *testing.T) {
			dialled := net.JoinHostPort(c.Address, "9090")
			target := "http://" + dialled + "/"
			t.Setenv(AllowedHostsEnv, "")
			switch c.Store {
			case "never":
				if got := CheckURL(target); !errors.Is(got, errMetadata) {
					t.Errorf("%s: CheckURL = %v", c.Form, got)
				}
				for _, listed := range []bool{false, true} {
					if got := checkDialled(dialled, listed); !errors.Is(got, errMetadata) {
						t.Errorf("%s: dialled, listed=%v: %v", c.Form, listed, got)
					}
				}
				t.Setenv(AllowedHostsEnv, c.Address)
				if got := CheckURL(target); !errors.Is(got, errMetadata) {
					t.Errorf("%s: on the list, CheckURL = %v", c.Form, got)
				}
			case "listed":
				if got := CheckURL(target); !namesTheSetting(got) {
					t.Errorf("%s: CheckURL = %v", c.Form, got)
				}
				if got := checkDialled(dialled, false); !namesTheSetting(got) {
					t.Errorf("%s: dialled = %v", c.Form, got)
				}
				if got := checkDialled(dialled, true); got != nil {
					t.Errorf("%s: dialled, listed = %v", c.Form, got)
				}
				t.Setenv(AllowedHostsEnv, c.Address)
				if got := CheckURL(target); got != nil {
					t.Errorf("%s: on the list, CheckURL = %v", c.Form, got)
				}
			case "open":
				if got := CheckURL(target); got != nil {
					t.Errorf("%s: CheckURL = %v", c.Form, got)
				}
				if got := checkDialled(dialled, false); got != nil {
					t.Errorf("%s: dialled = %v", c.Form, got)
				}
				t.Setenv(AllowedHostsEnv, "store.example.com")
				if got := CheckURL(target); !errors.Is(got, errNotOnList) {
					t.Errorf("%s: another host on the list, CheckURL = %v", c.Form, got)
				}
			default:
				t.Fatalf("store = %q", c.Store)
			}
		})
	}
}

func TestMetadataHostNamesAreRefused(t *testing.T) {
	for _, host := range []string{"metadata.google.internal", "metadata.goog", "metadata", "instance-data"} {
		if got := CheckURL("http://" + host + "/"); !errors.Is(got, errMetadata) {
			t.Errorf("%s: %v, want the metadata refusal", host, got)
		}
	}
}

func TestCheckedAddressesByClass(t *testing.T) {
	for _, c := range []struct {
		address string
		listed  bool
		want    error
	}{
		{"169.254.169.254:80", false, errMetadata},
		{"169.254.169.254:80", true, errMetadata},
		{"[fd00:ec2::254]:80", true, errMetadata},
		{"[fe80::1%en0]:80", false, errMetadata},
		{"[::ffff:169.254.169.254]:80", false, errMetadata},
		{"[64:ff9b::a9fe:a9fe]:80", false, errMetadata},
		{"[2002:a9fe:a9fe::]:80", false, errMetadata},
		{"127.0.0.1:80", false, errOwnHost},
		{"[::1]:80", false, errOwnHost},
		{"0.0.0.0:80", false, errOwnHost},
		{"[::ffff:127.0.0.1]:80", false, errOwnHost},
		{"[64:ff9b::7f00:1]:80", false, errOwnHost},
		{"127.0.0.1:80", true, nil},
		{"10.84.0.5:9090", false, nil},
		{"172.18.0.3:30090", false, nil},
		{"192.168.1.10:9090", false, nil},
		{"100.64.0.1:9090", false, nil},
		{"[fd12:3456::1]:9090", false, nil},
		{"8.8.8.8:443", false, nil},
	} {
		if got := checkDialled(c.address, c.listed); got != c.want {
			t.Errorf("%s listed=%v: %v, want %v", c.address, c.listed, got, c.want)
		}
	}
	if err := checkDialled("not an address", true); err == nil {
		t.Error("an address that cannot be read passed")
	}
}

// A name is checked where it ends up: this dial bypasses the check of the URL's host.
func TestDialRefusesTheServiceItselfBeforeConnecting(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := &atomic.Int32{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			_ = c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := dial(ctx, "tcp", ln.Addr().String()); err == nil || !strings.Contains(err.Error(), allowedHostsValue) {
		t.Fatalf("dial = %v, want the refusal naming the setting", err)
	}
	if accepted.Load() != 0 {
		t.Errorf("%d connections reached the listener", accepted.Load())
	}
	t.Setenv(AllowedHostsEnv, "127.0.0.1")
	conn, err := dial(ctx, "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("listed host: %v", err)
	}
	_ = conn.Close()
}

func TestClientKeepsTheDefaultTransportSettings(t *testing.T) {
	c := Client(5 * time.Second)
	base := http.DefaultTransport.(*http.Transport)
	got := c.Transport.(checkedTransport).next.(*http.Transport)
	if got.Proxy == nil || got.TLSHandshakeTimeout != base.TLSHandshakeTimeout || got.MaxIdleConns != base.MaxIdleConns || c.Timeout != 5*time.Second {
		t.Errorf("transport = %+v", got)
	}
}

// storePair is a store's https address that sends each request to its http one, and the requests that reached each.
func storePair(t *testing.T, target string) (client *http.Client, tlsURL string, plainSeen *atomic.Int32) {
	t.Helper()
	t.Setenv(AllowedHostsEnv, "127.0.0.1")
	plainSeen = &atomic.Int32{}
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plainSeen.Add(1)
		_, _ = w.Write([]byte("answer"))
	}))
	t.Cleanup(plain.Close)
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/here" {
			_, _ = w.Write([]byte("answer"))
			return
		}
		to := target
		if to == "" {
			to = plain.URL + "/api"
		}
		http.Redirect(w, r, to, http.StatusFound)
	}))
	t.Cleanup(secure.Close)
	client = Client(time.Second)
	client.Transport.(checkedTransport).next.(*http.Transport).TLSClientConfig = secure.Client().Transport.(*http.Transport).TLSClientConfig
	return client, secure.URL, plainSeen
}

func storeGet(client *http.Client, url, auth string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	return client.Do(req)
}

func TestARedirectFromHTTPSToHTTPDoesNotCarryTheCredential(t *testing.T) {
	client, secure, plainSeen := storePair(t, "")
	resp, err := storeGet(client, secure+"/api", "Bearer fake-store-token")
	if err == nil {
		resp.Body.Close()
		t.Errorf("followed: %d", resp.StatusCode)
	}
	if plainSeen.Load() != 0 {
		t.Errorf("the plain address got %d requests with the credential", plainSeen.Load())
	}
	if err != nil && !strings.Contains(err.Error(), "https") {
		t.Errorf("the error does not say what happened: %v", err)
	}
	if err != nil && strings.Contains(err.Error(), "fake-store-token") {
		t.Errorf("the error holds the credential: %v", err)
	}
}

func TestARedirectFromHTTPSToHTTPWithNoCredentialStillWorks(t *testing.T) {
	client, secure, plainSeen := storePair(t, "")
	resp, err := storeGet(client, secure+"/api", "")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || plainSeen.Load() != 1 {
		t.Errorf("%d, plain address asked %d times", resp.StatusCode, plainSeen.Load())
	}
}

func TestARedirectInsideHTTPSKeepsTheCredential(t *testing.T) {
	client, secure, plainSeen := storePair(t, "/here")
	resp, err := storeGet(client, secure+"/api", "Bearer fake-store-token")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || plainSeen.Load() != 0 {
		t.Errorf("%d, plain address asked %d times", resp.StatusCode, plainSeen.Load())
	}
}

func TestARedirectFromHTTPToHTTPSKeepsTheCredential(t *testing.T) {
	t.Setenv(AllowedHostsEnv, "127.0.0.1")
	var got atomic.Value
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.Store(r.Header.Get("Authorization"))
		_, _ = w.Write([]byte("answer"))
	}))
	defer secure.Close()
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, secure.URL+"/api", http.StatusFound)
	}))
	defer plain.Close()
	client := Client(time.Second)
	client.Transport.(checkedTransport).next.(*http.Transport).TLSClientConfig = secure.Client().Transport.(*http.Transport).TLSClientConfig
	resp, err := storeGet(client, plain.URL+"/api", "Bearer fake-store-token")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || got.Load() != "Bearer fake-store-token" {
		t.Errorf("%d, Authorization %v", resp.StatusCode, got.Load())
	}
}

func TestARedirectInsideHTTPKeepsItsPath(t *testing.T) {
	t.Setenv(AllowedHostsEnv, "127.0.0.1")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/moved" {
			_, _ = w.Write([]byte("answer"))
			return
		}
		http.Redirect(w, r, "/moved", http.StatusFound)
	}))
	defer srv.Close()
	resp, err := storeGet(Client(time.Second), srv.URL+"/api", "Bearer fake-store-token")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("%d", resp.StatusCode)
	}
}

func TestRedirectsStayOnTheHostAndStop(t *testing.T) {
	t.Setenv(AllowedHostsEnv, "127.0.0.1")
	hops := &atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops.Add(1)
		http.Redirect(w, r, "/again", http.StatusFound)
	}))
	defer srv.Close()
	_, err := Client(time.Second).Get(srv.URL)
	if err == nil || !strings.Contains(err.Error(), "10 redirects") {
		t.Errorf("err = %v", err)
	}
	if hops.Load() != 10 {
		t.Errorf("hops = %d", hops.Load())
	}
}
