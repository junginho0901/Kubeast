// Package storeurl is the address rule for the metrics and log store URLs registered on a cluster. Whoever may edit a
// cluster names an address that k8s-service then calls with its own network position, so the rule runs when the URL is
// saved, before each request and when a name has resolved to an address.
//
//   - Cloud metadata and link-local addresses are never called.
//   - The service's own machine (loopback, unspecified) is called only when its host is on the allow list.
//   - Anything else, private ranges included, is open while the list is empty: stores in the cluster or the company
//     network are the usual case. With a list, only the hosts on it.
//
// The chart's own store URLs are the installer's and do not come through here.
package storeurl

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

// AllowedHostsEnv lists exact hosts and ".suffix" entries (the host and every subdomain), comma-separated, as
// AI_BASE_URL_ALLOWED_HOSTS does for model URLs. Read on every call.
const AllowedHostsEnv = "CLUSTER_STORE_ALLOWED_HOSTS"

const allowedHostsValue = "features.clusterStoreAllowedHosts"

var (
	errMetadata  = errors.New("cloud metadata and link-local addresses are not allowed")
	errOwnHost   = errors.New("this address is the service's own machine; to use it, add the host to " + allowedHostsValue)
	errNotOnList = errors.New("this host is not in " + allowedHostsValue)
)

var metadataHosts = map[string]bool{"metadata.google.internal": true, "metadata": true, "instance-data": true}

var (
	metadataNetworks = []netip.Prefix{netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("fe80::/10"), netip.MustParsePrefix("fd00:ec2::254/128")}
	ownHostNetworks  = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128"), netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("::/128")}
	nat64            = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour        = netip.MustParsePrefix("2002::/16")
)

func allowedHosts() []string {
	var out []string
	for _, h := range strings.Split(os.Getenv(AllowedHostsEnv), ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out = append(out, h)
		}
	}
	return out
}

func listed(host string, allowed []string) bool {
	for _, a := range allowed {
		if host == a || (strings.HasPrefix(a, ".") && (host == a[1:] || strings.HasSuffix(host, a))) {
			return true
		}
	}
	return false
}

func normalize(host string) string { return strings.ToLower(strings.TrimSuffix(host, ".")) }

// plain is the IPv4 address an IPv6 spelling carries, or the address itself.
func plain(a netip.Addr) netip.Addr {
	a = a.Unmap().WithZone("")
	b := a.As16()
	switch {
	case nat64.Contains(a):
		return netip.AddrFrom4([4]byte(b[12:16]))
	case sixToFour.Contains(a):
		return netip.AddrFrom4([4]byte(b[2:6]))
	}
	return a
}

func in(a netip.Addr, networks []netip.Prefix) bool {
	for _, n := range networks {
		if n.Contains(a) {
			return true
		}
	}
	return false
}

// CheckURL says whether a store may be called at raw, going by its host as written. What a name resolves to is checked
// when it is dialled: at save time the name may not resolve yet from where this runs.
func CheckURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return err
	}
	host := normalize(u.Hostname())
	addr, addrErr := netip.ParseAddr(host)
	if addrErr == nil {
		addr = plain(addr)
	}
	if metadataHosts[host] || (addrErr == nil && in(addr, metadataNetworks)) {
		return errMetadata
	}
	allowed := allowedHosts()
	if listed(host, allowed) {
		return nil
	}
	if len(allowed) > 0 {
		return errNotOnList
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || (addrErr == nil && in(addr, ownHostNetworks)) {
		return errOwnHost
	}
	return nil
}

// checkDialled is the same rule for the address a dial reached: hostListed is the operator having vouched for the name.
func checkDialled(address string, hostListed bool) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("cannot read the address %q: %w", address, err)
	}
	a := plain(ap.Addr())
	switch {
	case in(a, metadataNetworks):
		return errMetadata
	case in(a, ownHostNetworks) && !hostListed:
		return errOwnHost
	}
	return nil
}

func dial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	hostListed := listed(normalize(host), allowedHosts())
	d := net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(_, address string, _ syscall.RawConn) error {
			return checkDialled(address, hostListed)
		},
	}
	return d.DialContext(ctx, network, addr)
}

type checkedTransport struct{ next http.RoundTripper }

func (t checkedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := CheckURL(req.URL.String()); err != nil {
		return nil, err
	}
	return t.next.RoundTrip(req)
}

// stayOnHost follows a store's redirects on its own host (http to https, a path behind a proxy) and no further: the
// registered URL is what was checked and what its credentials are for. A credential does not go from https to http.
func stayOnHost(req *http.Request, via []*http.Request) error {
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	if !strings.EqualFold(normalize(req.URL.Hostname()), normalize(via[0].URL.Hostname())) {
		return fmt.Errorf("the store redirected to another host (%s); register the address it answers on", req.URL.Hostname())
	}
	// The client copies the header to a redirect on the same host, where this one would send it in the clear.
	if req.Header.Get("Authorization") != "" && via[len(via)-1].URL.Scheme == "https" && req.URL.Scheme == "http" {
		return errors.New("the store redirected from https to http, which would send its credential unencrypted; register the address it answers on")
	}
	return nil
}

// Client is an HTTP client for registered stores. It keeps the default transport's proxy, TLS and pool settings.
func Client(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dial
	return &http.Client{Timeout: timeout, Transport: checkedTransport{transport}, CheckRedirect: stayOnHost}
}
