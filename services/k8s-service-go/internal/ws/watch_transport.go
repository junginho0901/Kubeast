package ws

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	utilnet "k8s.io/apimachinery/pkg/util/net"
	"k8s.io/client-go/rest"
)

// defaultWatchStreamWindow is how much of one watch the API server may send before k8s-service has read it (HTTP/2
// flow control; Go's default is 4 MiB a stream), multicluster.wsWatchStreamWindowKiB. It costs both ways: a watch whose
// browser reads slowly gives its opening place back and waits with this much of its list unread, and a stream reads
// at most this much a round trip. Measured on a laptop, the live heap 16 slow browsers opening 2 000 objects of 4 KB
// took and a 26 MB watch list over a 50 ms round trip: 256 KiB +4.7 MiB and 5.3 s, 512 KiB +10 MiB and 2.7 s, 1 MiB
// +18 MiB and 1.4 s, 2 MiB +33 MiB and 0.75 s, Go's 4 MiB +65 MiB and 0.69 s.
const defaultWatchStreamWindow = 1 << 20

// windowNotSet logs once that the watches' streams keep Go's window.
var windowNotSet sync.Once

// watchStreamConfig is cfg for the watches' client: a transport of its own (a dial of its own keeps client-go from
// handing out the cluster's shared one) whose HTTP/2 streams take window bytes (0: defaultWatchStreamWindow). A config
// that brings its own Transport keeps it as it is, and that is logged once; a CA file's reload clones the transport,
// the setting with it.
func watchStreamConfig(cfg *rest.Config, window int) *rest.Config {
	if window <= 0 {
		window = defaultWatchStreamWindow
	}
	c := rest.CopyConfig(cfg)
	if c.Dial == nil {
		c.Dial = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	own := c.Transport == nil
	wrap := c.WrapTransport
	c.WrapTransport = func(rt http.RoundTripper) http.RoundTripper {
		switch tr := baseTransport(rt); {
		case tr == http.DefaultTransport:
			// no TLS and no dial of its own: client-go hands out net/http's, which stays as it is (HTTP/1.1)
		case tr != nil && own:
			var h2 http.HTTP2Config
			if tr.HTTP2 != nil {
				h2 = *tr.HTTP2
			}
			h2.MaxReceiveBufferPerStream = window
			tr.HTTP2 = &h2
		default:
			windowNotSet.Do(func() {
				slog.Warn("live list watches keep Go's HTTP/2 stream window: the cluster's transport cannot be set",
					"transport", fmt.Sprintf("%T", rt), "own_transport", !own)
			})
		}
		if wrap != nil {
			return wrap(rt)
		}
		return rt
	}
	return c
}

// baseTransport is the *http.Transport under client-go's wrappers (its TLS cache's trackedTransport, the CA file
// reload's holder), or nil.
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
