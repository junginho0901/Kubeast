// Package storeurl is the address rule for the metrics and log store URLs registered on a cluster. Whoever may edit a
// cluster names an address that k8s-service then calls with its own network position, so the rule runs when the URL is
// saved, before each request and when a name has resolved to an address.
//
//   - Cloud metadata and link-local addresses are never called.
//   - The service's own machine (loopback, unspecified) and addresses nothing answers on are called only when their host
//     is on the allow list.
//   - Anything else, private ranges included, is open while the list is empty: stores in the cluster or the company
//     network are the usual case. With a list, only the hosts on it.
//
// An IPv6 form counts as each IPv4 address it carries. The chart's own store URLs are the installer's and do not come
// through here.
//
// Through a proxy in the service's environment (HTTP_PROXY, HTTPS_PROXY) only the host as written is checked: the proxy
// resolves the name and connects, so the dial check sees the proxy's address. A host under NO_PROXY is dialled here and
// checked. ai-service's model connections make the same choice (app/services/model_http.py).
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
	errNoAnswer  = errors.New("nothing answers on this address; to use it, add the host to " + allowedHostsValue)
	errNotOnList = errors.New("this host is not in " + allowedHostsValue)
)

var metadataHosts = map[string]bool{"metadata.google.internal": true, "metadata.goog": true, "metadata": true, "instance-data": true}

var (
	// Besides the link-local ranges: AWS's IPv6 metadata address, Alibaba Cloud's metadata address and Azure's platform address.
	metadataNetworks = []netip.Prefix{netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("fe80::/10"), netip.MustParsePrefix("fd00:ec2::254/128"), netip.MustParsePrefix("fd20:ce::254/128"), netip.MustParsePrefix("100.100.100.200/32"), netip.MustParsePrefix("168.63.129.16/32")}
	ownHostNetworks  = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128"), netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("::/128")}
	// Multicast, the broadcast address and the prefix routers discard (RFC 6666). Class E, 192.0.0.0/24, 2001:db8::/32 and
	// site-local are not here: a Google Cloud subnet and kubeadm's dual-stack examples use the first three for a cluster, and
	// a network may keep the last as a private range.
	noAnswerNetworks = []netip.Prefix{netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("ff00::/8"), netip.MustParsePrefix("255.255.255.255/32"), netip.MustParsePrefix("100::/64")}
	teredo           = netip.MustParsePrefix("2001::/32")
	sixToFour        = netip.MustParsePrefix("2002::/16")
	// IPv6 forms with an IPv4 address in their low 32 bits: NAT64, a site's own NAT64 (RFC 8215, read as its usual /96),
	// IPv4-translated (SIIT) and the old IPv4-compatible one.
	ipv4InLowBits = []netip.Prefix{netip.MustParsePrefix("64:ff9b::/96"), netip.MustParsePrefix("::ffff:0:0:0/96"), netip.MustParsePrefix("::/96")}
	// A site's own NAT64 prefix (RFC 8215), whose length the address does not say: see siteNAT64Addresses.
	siteNAT64 = netip.MustParsePrefix("64:ff9b:1::/48")
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

// reached is the address and each IPv4 address its form carries: an IPv6 form reaches that address, and a network of the
// other version never contains it. A public IPv4 address behind NAT64 stays open. Teredo carries two, its server and its
// client, which is stored inverted. ISATAP's interface part is 0:5efe, with the universal and group bits free.
func reached(a netip.Addr) []netip.Addr {
	a = a.Unmap().WithZone("")
	if a.Is4() {
		return []netip.Addr{a}
	}
	b := a.As16()
	isatap := b[8]&^0x03 == 0 && b[9] == 0 && b[10] == 0x5e && b[11] == 0xfe
	switch {
	case teredo.Contains(a):
		return []netip.Addr{a, netip.AddrFrom4([4]byte(b[4:8])), netip.AddrFrom4([4]byte{^b[12], ^b[13], ^b[14], ^b[15]})}
	case sixToFour.Contains(a):
		return []netip.Addr{a, netip.AddrFrom4([4]byte(b[2:6]))}
	case siteNAT64.Contains(a):
		return append([]netip.Addr{a}, siteNAT64Addresses(b)...)
	case isatap || inAny(a, ipv4InLowBits):
		return []netip.Addr{a, netip.AddrFrom4([4]byte(b[12:16]))}
	}
	return []netip.Addr{a}
}

// siteNAT64Addresses is each IPv4 address a site's own NAT64 form can carry. RFC 6052 places it by the prefix's length, /48,
// /56, /64 or /96, with bits 64 to 71 empty and nothing after it, and the address does not say which: every reading that
// fits counts. A first octet of 0 is the empty part of another reading, so it counts only when nothing else does.
func siteNAT64Addresses(b [16]byte) []netip.Addr {
	empty := func(from int) bool {
		for _, c := range b[from:] {
			if c != 0 {
				return false
			}
		}
		return true
	}
	var forms [][4]byte
	if !empty(12) {
		forms = append(forms, [4]byte(b[12:16]))
	}
	if b[8] == 0 {
		if empty(11) {
			forms = append(forms, [4]byte{b[6], b[7], b[9], b[10]})
		}
		if empty(12) {
			forms = append(forms, [4]byte{b[7], b[9], b[10], b[11]})
		}
		if empty(13) {
			forms = append(forms, [4]byte(b[9:13]))
		}
	}
	var out []netip.Addr
	for _, f := range forms {
		if f[0] != 0 {
			out = append(out, netip.AddrFrom4(f))
		}
	}
	if len(out) == 0 {
		return []netip.Addr{netip.AddrFrom4([4]byte(b[12:16]))}
	}
	return out
}

func inAny(a netip.Addr, networks []netip.Prefix) bool {
	for _, n := range networks {
		if n.Contains(a) {
			return true
		}
	}
	return false
}

func in(a netip.Addr, networks []netip.Prefix) bool {
	for _, r := range reached(a) {
		if inAny(r, networks) {
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
	if addrErr == nil && in(addr, noAnswerNetworks) {
		return errNoAnswer
	}
	return nil
}

// checkDialled is the same rule for the address a dial reached: hostListed is the operator having vouched for the name.
func checkDialled(address string, hostListed bool) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("cannot read the address %q: %w", address, err)
	}
	a := ap.Addr()
	switch {
	case in(a, metadataNetworks):
		return errMetadata
	case hostListed:
		return nil
	case in(a, ownHostNetworks):
		return errOwnHost
	case in(a, noAnswerNetworks):
		return errNoAnswer
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

// Client is an HTTP client for registered stores. It keeps the default transport's proxy (see the package comment), TLS
// and pool settings.
func Client(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = dial
	return &http.Client{Timeout: timeout, Transport: checkedTransport{transport}, CheckRedirect: stayOnHost}
}
