package ws

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// frameReason reads the machine reason beside a frame's message.
func frameReason(t *testing.T, f frame) string {
	t.Helper()
	if f.Type != "ERROR" {
		t.Fatalf("frame = %+v, want ERROR", f)
	}
	return f.Error.Reason
}

func TestAWatchThatCannotReachTheClusterTellsTheClientNoAddress(t *testing.T) {
	gone := httptest.NewServer(http.NotFoundHandler())
	addr := gone.URL
	gone.Close()
	d, err := dynamic.NewForConfig(&rest.Config{Host: addr, QPS: -1})
	if err != nil {
		t.Fatal(err)
	}
	m := NewMultiplexer(fakeClients{d})
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	f := nextFrame(t, conn)
	if reason := frameReason(t, f); reason != reasonUnreachable {
		t.Fatalf("reason = %q", reason)
	}
	host := strings.TrimPrefix(addr, "http://")
	if strings.Contains(f.Error.Message, host) || strings.Contains(f.Error.Message, "127.0.0.1") {
		t.Fatalf("message names the API server: %q", f.Error.Message)
	}
}

func TestAWatchTheClusterRefusesSaysSo(t *testing.T) {
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Forbidden","code":403,"message":"pods is forbidden: User \"a\" cannot watch resource \"pods\""}`))
	})
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	f := nextFrame(t, conn)
	if reason := frameReason(t, f); reason != reasonForbidden {
		t.Fatalf("reason = %q", reason)
	}
	if !strings.Contains(f.Error.Message, "cannot watch resource") {
		t.Fatalf("message = %q", f.Error.Message)
	}
}

func TestAKindTheClusterDoesNotServeIsNoProblemToReport(t *testing.T) {
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"NotFound","code":404,"message":"the server could not find the requested resource"}`))
	})
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/apis/gateway.networking.k8s.io/v1/gateways", "watch=1")
	if reason := frameReason(t, nextFrame(t, conn)); reason != reasonNotServed {
		t.Fatalf("reason = %q", reason)
	}
}

func TestAWatchOfAnUnknownResourceSaysItIsUnsupported(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/apis/example.com/v1/gadgets", "watch=1")
	if reason := frameReason(t, nextFrame(t, conn)); reason != reasonUnsupported {
		t.Fatalf("reason = %q", reason)
	}
}

func TestAClusterTheCallerHasNoGrantOnIsARefusal(t *testing.T) {
	m := muxOn(t, eventThenHold)
	conn := socketTo(t, m, map[string][]string{"other": {"resource.*.read"}})
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	if reason := frameReason(t, nextFrame(t, conn)); reason != reasonForbidden {
		t.Fatalf("reason = %q", reason)
	}
}

// A live list reads what the list route reads, so it asks what that route asks.
func TestAWatchAsksWhatTheListAsks(t *testing.T) {
	const key = "resource.objects.read"
	for _, c := range []struct {
		name    string
		perms   auth.PermissionMatrix
		refused bool
	}{
		{"menus only", auth.PermissionMatrix{"c1": {"menu.*"}}, true},
		{"AI tools only", auth.PermissionMatrix{"c1": {"ai.tool.*"}}, true},
		{"Pod logs only", auth.PermissionMatrix{"c1": {"resource.pod.read"}}, true},
		{"the key on another cluster", auth.PermissionMatrix{"c1": {"menu.*"}, "c2": {key}}, true},
		{"the key", auth.PermissionMatrix{"c1": {key}}, false},
		{"the Read role's wildcard", auth.PermissionMatrix{"c1": {"resource.*.read"}}, false},
		{"Admin on the cluster", auth.PermissionMatrix{"c1": {"*"}}, false},
		{"global admin", everyCluster, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := muxOn(t, eventThenHold)
			conn := socketTo(t, m, c.perms)
			request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
			f := nextFrame(t, conn)
			if c.refused {
				if reason := frameReason(t, f); reason != reasonForbidden {
					t.Fatalf("reason = %q", reason)
				}
				if !strings.Contains(f.Error.Message, key) {
					t.Fatalf("message = %q, want it to name %s", f.Error.Message, key)
				}
				if got := m.SubscriptionCount(); got != 0 {
					t.Fatalf("%d subscriptions, want none opened", got)
				}
				return
			}
			if f.Type == "ERROR" {
				t.Fatalf("frame = %+v, want the watch to run", f)
			}
		})
	}
}

func TestTheTabsLimitIsReportedAsALimit(t *testing.T) {
	m := muxOn(t, eventThenHold)
	m.MaxSubscriptionsPerConn = 1
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("first frame = %+v", f)
	}
	request(t, conn, "REQUEST", "c1", "/api/v1/services", "watch=1")
	f := nextFrame(t, conn)
	if reason := frameReason(t, f); reason != reasonLimit {
		t.Fatalf("reason = %q", reason)
	}
}

func TestAWatchBackAfterAFailureAsksTheClientToReadTheListAgain(t *testing.T) {
	var calls atomic.Int32
	m := muxOn(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"apiVersion":"v1","kind":"Status","status":"Failure","reason":"ServiceUnavailable","code":503,"message":"try later"}`))
			return
		}
		eventThenHold(w, r)
	})
	conn := socketTo(t, m, everyCluster)
	request(t, conn, "REQUEST", "c1", "/api/v1/pods", "watch=1")
	if f := nextFrame(t, conn); f.Type != "ERROR" {
		t.Fatalf("first frame = %+v", f)
	}
	// The retry waits its 5 seconds: the client hears the watch is back before its first event.
	if f := nextFrame(t, conn); f.Type != "RESYNC" {
		t.Fatalf("second frame = %+v, want RESYNC", f)
	}
	if f := nextFrame(t, conn); f.Type != "DATA" {
		t.Fatalf("third frame = %+v, want DATA", f)
	}
}
