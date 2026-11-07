package response

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"testing"
)

func TestPublicLeavesTheAddressOfAFailedCallOut(t *testing.T) {
	refused := &net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.IPv4(10, 1, 2, 3), Port: 3200}, Err: errors.New("connect: connection refused")}
	call := &url.Error{Op: "Get", URL: "http://tempo.internal:3200/api/search?q=x", Err: refused}
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"a wrapped URL error", fmt.Errorf("trace store: %w", call), "trace store: " + upstreamUnreachable},
		{"a URL error flattened to text", fmt.Errorf("flow source unavailable: %v", call), "flow source unavailable: " + upstreamUnreachable},
		{"the URL error alone", call, upstreamUnreachable},
		{"a POST", &url.Error{Op: "Post", URL: "https://k8s.internal:6443/api", Err: errors.New("EOF")}, upstreamUnreachable},
		{"a dial with no URL", fmt.Errorf("log store: %w", refused), "log store: " + upstreamUnreachable},
		{"a name lookup", errors.New("log store: lookup loki.internal on 10.96.0.10:53: no such host"), "log store: " + upstreamUnreachable},
	}
	for _, tc := range cases {
		got := Public(tc.err)
		if got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
		for _, secret := range []string{"tempo.internal", "k8s.internal", "loki.internal", "10.1.2.3", "10.96.0.10"} {
			if strings.Contains(got, secret) {
				t.Errorf("%s: %q names %s", tc.name, got, secret)
			}
		}
	}
}

func TestPublicKeepsWhatTheServerItselfSaid(t *testing.T) {
	for _, msg := range []string{
		`pods is forbidden: User "a@example.com" cannot list resource "pods" in API group "" in the namespace "shop"`,
		`trace store did not answer in time`,
		`metrics store error (status 502): bad gateway`,
		`trace store answered 400: invalid TraceQL at "get" position 3`,
		`the Get "button" of this query`,
	} {
		if got := Public(errors.New(msg)); got != msg {
			t.Errorf("%q became %q", msg, got)
		}
	}
}

func TestPublicOfNoErrorIsEmpty(t *testing.T) {
	if got := Public(nil); got != "" {
		t.Fatalf("got %q", got)
	}
}
