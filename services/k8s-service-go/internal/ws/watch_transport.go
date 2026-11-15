package ws

import (
	"net"
	"net/http"
	"time"

	utilnet "k8s.io/apimachinery/pkg/util/net"
	"k8s.io/client-go/rest"
)

// watchStreamBuffer is how much of one watch the API server may send before k8s-service has read it (HTTP/2 flow
// control; Go's default is 4 MiB a stream). A watch whose browser reads slowly gives its opening place back and waits
// with this much at most: 16 slow browsers opening lists of 2 000 objects of 4 KB took the live heap 66 MiB up with
// Go's default and 5 MiB with this (TestSlowBrowsersHoldLittleOfTheirLists).
const watchStreamBuffer = 256 << 10

// watchStreamConfig is cfg for the watches' client: a transport of its own (a dial of its own keeps client-go from
// handing out the cluster's shared one, whose lists keep Go's window) whose HTTP/2 streams take watchStreamBuffer. A
// config that brings its own Transport keeps it as it is; a CA file's reload clones the transport, the setting with it.
func watchStreamConfig(cfg *rest.Config) *rest.Config {
	c := rest.CopyConfig(cfg)
	if c.Dial == nil {
		c.Dial = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	own := c.Transport == nil
	wrap := c.WrapTransport
	c.WrapTransport = func(rt http.RoundTripper) http.RoundTripper {
		if tr := baseTransport(rt); tr != nil && own && tr != http.DefaultTransport {
			var h2 http.HTTP2Config
			if tr.HTTP2 != nil {
				h2 = *tr.HTTP2
			}
			h2.MaxReceiveBufferPerStream = watchStreamBuffer
			tr.HTTP2 = &h2
		}
		if wrap != nil {
			return wrap(rt)
		}
		return rt
	}
	return c
}

// baseTransport is the *http.Transport under client-go's wrappers (its TLS cache's trackedTransport), or nil.
func baseTransport(rt http.RoundTripper) *http.Transport {
	for {
		switch t := rt.(type) {
		case *http.Transport:
			return t
		case utilnet.RoundTripperWrapper:
			rt = t.WrappedRoundTripper()
		default:
			return nil
		}
	}
}
