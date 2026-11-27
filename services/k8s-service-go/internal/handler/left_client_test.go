package handler

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/metrics"
)

// countedServer is a route of the cluster c1 behind the metrics and ClusterMiddleware, in main.go's order.
func countedServer(t *testing.T, h *Handler, route http.HandlerFunc) (*httptest.Server, *metrics.Metrics) {
	t.Helper()
	m := metrics.New("k8s")
	m.Route = metrics.ChiRoute
	r := chi.NewRouter()
	r.Use(m.Middleware)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := auth.TokenPayload{UserID: "u1", Perms: auth.PermissionMatrix{"*": {"*"}}}
			next.ServeHTTP(w, r.WithContext(auth.WithPayload(r.Context(), p)))
		})
	})
	r.Use(h.ClusterMiddleware)
	r.Get("/api/v1/read", route)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, m
}

// readCodes waits for the count of /api/v1/read and returns its lines.
func readCodes(t *testing.T, m *metrics.Metrics) string {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		w := httptest.NewRecorder()
		m.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
		var lines []string
		for _, line := range strings.Split(w.Body.String(), "\n") {
			if strings.HasPrefix(line, "kubeast_http_requests_total{") {
				lines = append(lines, line)
			}
		}
		if len(lines) > 0 {
			return strings.Join(lines, "\n")
		}
	}
	return ""
}

func readCounted(code string) string {
	return `kubeast_http_requests_total{code="` + code + `",method="get",route="/api/v1/read",service="k8s"} 1`
}

// A page closed while its cluster read is on its way: the read ends with the request, the handler answers its 500 to no
// one, and the request counts as 499.
func TestAClusterReadWhoseClientLeftCountsAs499(t *testing.T) {
	h := breakerHandler(t, k8s.ServiceOptions{BreakerFails: 5, BreakerOpen: time.Minute})
	begun, answered := make(chan struct{}), make(chan int, 1)
	srv, m := countedServer(t, h, func(w http.ResponseWriter, r *http.Request) {
		close(begun)
		_, _, err := h.svc.RawRequest(r.Context(), http.MethodGet, slowAPIPath)
		if err == nil {
			err = errors.New("the read was answered")
		}
		answered <- statusForError(err)
		h.handleError(w, err)
	})
	ctx, leave := context.WithCancel(context.Background())
	go func() {
		<-begun
		time.Sleep(100 * time.Millisecond)
		leave()
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/v1/read?cluster=c1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := srv.Client().Do(req); !errors.Is(err, context.Canceled) {
		t.Fatalf("the client ended with %v", err)
	}
	if status := <-answered; status != http.StatusInternalServerError {
		t.Fatalf("the handler's answer is %d, want its 500", status)
	}
	if got := readCodes(t, m); got != readCounted("499") {
		t.Fatalf("counted %s", got)
	}
}

// A read cut by something else than its client (another waiter's, a server ending) is answered 500 to whoever waits for it.
func TestAReadCutWithItsClientThereIsA500(t *testing.T) {
	h := breakerHandler(t, k8s.ServiceOptions{BreakerFails: 5, BreakerOpen: time.Minute})
	srv, m := countedServer(t, h, func(w http.ResponseWriter, r *http.Request) {
		h.handleError(w, fmt.Errorf("list events: %w", context.Canceled))
	})
	res, err := srv.Client().Get(srv.URL + "/api/v1/read?cluster=c1")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if got := readCodes(t, m); res.StatusCode != http.StatusInternalServerError || got != readCounted("500") {
		t.Fatalf("answered %d, counted %s", res.StatusCode, got)
	}
}

// A terminal's upgrade and an event stream go through the metrics and the access recorder as they did, and count as 200.
func TestATerminalAndAStreamGoThroughTheMetrics(t *testing.T) {
	h := breakerHandler(t, k8s.ServiceOptions{BreakerFails: 5, BreakerOpen: time.Minute})

	srv, m := countedServer(t, h, func(w http.ResponseWriter, r *http.Request) {
		conn, err := debugUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		kind, said, err := conn.ReadMessage()
		if err == nil {
			err = conn.WriteMessage(kind, append([]byte("echo "), said...))
		}
		if err != nil {
			t.Error(err)
		}
	})
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/read?cluster=c1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if _, said, err := conn.ReadMessage(); err != nil || string(said) != "echo hello" {
		t.Fatalf("over the socket %q, %v", said, err)
	}
	if got := readCodes(t, m); got != readCounted("200") {
		t.Fatalf("the terminal counted %s", got)
	}

	held := make(chan struct{})
	srv, m = countedServer(t, h, func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Error("the stream cannot flush")
			return
		}
		_, _ = io.WriteString(w, "data: 1\n\n")
		flusher.Flush()
		select {
		case <-held:
		case <-r.Context().Done():
		}
	})
	client := srv.Client()
	client.Timeout = 10 * time.Second
	res, err := client.Get(srv.URL + "/api/v1/read?cluster=c1")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if line, err := bufio.NewReader(res.Body).ReadString('\n'); err != nil || line != "data: 1\n" {
		t.Fatalf("first event %q, %v", line, err)
	}
	close(held)
	if got := readCodes(t, m); got != readCounted("200") {
		t.Fatalf("the stream counted %s", got)
	}
}
