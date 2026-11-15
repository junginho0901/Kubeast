package ws

import (
	"net/http"
	"testing"

	"k8s.io/client-go/rest"
)

// The watches' client asks the API server for at most watchStreamBuffer unread a stream, through client-go's wrappers
// of its transport, and leaves the cluster's own client as it is.
func TestTheWatchClientsStreamsTakeWatchStreamBuffer(t *testing.T) {
	cfg := &rest.Config{Host: "https://127.0.0.1:6443", TLSClientConfig: rest.TLSClientConfig{Insecure: true}}
	streamBuffer := func(cfg *rest.Config) int {
		rt, err := rest.TransportFor(cfg)
		if err != nil {
			t.Fatal(err)
		}
		tr := baseTransport(rt)
		if tr == nil {
			t.Fatalf("no *http.Transport under %T", rt)
		}
		if tr.HTTP2 == nil {
			return 0
		}
		return tr.HTTP2.MaxReceiveBufferPerStream
	}
	if got := streamBuffer(watchStreamConfig(cfg)); got != watchStreamBuffer {
		t.Errorf("the watch client's stream buffer is %d, want %d", got, watchStreamBuffer)
	}
	if got := streamBuffer(cfg); got != 0 {
		t.Errorf("the cluster's client's stream buffer is %d, want Go's default", got)
	}
	plain := &rest.Config{Host: "http://127.0.0.1:8080"}
	if rt, err := rest.TransportFor(watchStreamConfig(plain)); err != nil || baseTransport(rt) == http.DefaultTransport {
		t.Errorf("a plain HTTP cluster's watch client took %T, %v; want a transport of its own", rt, err)
	}
}
