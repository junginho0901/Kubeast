package storeurl

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

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
