package metrics

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// counted is the lines of the two metrics that carry a code, without the histogram's times.
func counted(t *testing.T, m *Metrics) []string {
	t.Helper()
	var out []string
	for _, line := range strings.Split(scrape(t, m), "\n") {
		if strings.HasPrefix(line, "kubeast_http_requests_total{") || strings.HasPrefix(line, "kubeast_http_request_duration_seconds_count{") {
			out = append(out, line)
		}
	}
	sort.Strings(out)
	return out
}

// countedAs waits for one request of route, in both metrics, and fails on any code but want.
func countedAs(t *testing.T, m *Metrics, method, route, want string) {
	t.Helper()
	label := fmt.Sprintf(`{code="%s",method="%s",route="%s",service="%s"} 1`, want, method, route, m.Service)
	wantLines := []string{"kubeast_http_request_duration_seconds_count" + label, "kubeast_http_requests_total" + label}
	var got []string
	for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(5 * time.Millisecond) {
		if got = counted(t, m); len(got) >= len(wantLines) { // the counter's line comes a moment before the histogram's
			break
		}
	}
	if strings.Join(got, "\n") != strings.Join(wantLines, "\n") {
		t.Fatalf("counted\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(wantLines, "\n"))
	}
}

// served is a real server with one chi route behind the middleware.
func served(t *testing.T, m *Metrics, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	m.Route = ChiRoute
	r := chi.NewRouter()
	r.Use(m.Middleware)
	r.Handle("/read", h)
	srv := httptest.NewUnstartedServer(r)
	srv.Config.ErrorLog = quiet()
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

// quiet drops net/http's own lines: a second WriteHeader, an aborted handler.
func quiet() *log.Logger { return log.New(io.Discard, "", 0) }

// leave asks /read and goes away once the handler says it has begun.
func leave(t *testing.T, srv *httptest.Server, begun <-chan struct{}, after time.Duration) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-begun
		time.Sleep(after)
		cancel()
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/read", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := srv.Client().Do(req)
	if err == nil {
		_, err = io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("the client ended with %v", err)
	}
}

func TestARequestWhoseClientLeftCountsAs499(t *testing.T) {
	m, begun := New("test"), make(chan struct{})
	srv := served(t, m, func(w http.ResponseWriter, r *http.Request) {
		close(begun)
		<-r.Context().Done() // the read the handler was waiting on ends with the request
		http.Error(w, r.Context().Err().Error(), http.StatusInternalServerError)
	})
	leave(t, srv, begun, 0)
	countedAs(t, m, "get", "/read", "499")
}

// A wait that ran out, the console's, a proxy's or another service's, is a client gone too: the age tells them apart.
func TestARequestPastTheLimitStaysA500WhenItsClientGoes(t *testing.T) {
	m, begun := New("test"), make(chan struct{})
	m.leftWithin = 30 * time.Millisecond
	srv := served(t, m, func(w http.ResponseWriter, r *http.Request) {
		close(begun)
		<-r.Context().Done()
		http.Error(w, "context canceled", http.StatusInternalServerError)
	})
	leave(t, srv, begun, 150*time.Millisecond)
	countedAs(t, m, "get", "/read", "500")
}

func TestAClientThatLeavesAfterItsAnswerWasAnswered(t *testing.T) {
	for name, answer := range map[string]func(w http.ResponseWriter){
		"500": func(w http.ResponseWriter) { http.Error(w, "boom", http.StatusInternalServerError) },
		"200 from a write": func(w http.ResponseWriter) {
			_, _ = io.WriteString(w, "a")
		},
		"200 from a flush":   func(w http.ResponseWriter) { w.(http.Flusher).Flush() },
		"200 from a copy":    func(w http.ResponseWriter) { _, _ = io.Copy(w, only("a")) },
		"200 from a header":  func(w http.ResponseWriter) { w.WriteHeader(http.StatusOK) },
		"404 and then a 500": func(w http.ResponseWriter) { http.NotFound(w, httptest.NewRequest(http.MethodGet, "/", nil)) },
	} {
		t.Run(name, func(t *testing.T) {
			m, begun := New("test"), make(chan struct{})
			srv := served(t, m, func(w http.ResponseWriter, r *http.Request) {
				answer(w)
				close(begun)
				<-r.Context().Done()
				// The second status reaches no one and is the one counted, as before.
				w.WriteHeader(http.StatusInternalServerError)
			})
			leave(t, srv, begun, 0)
			countedAs(t, m, "get", "/read", "500")
		})
	}
}

// Every status by every state of the client: only a 500 whose client left early is renamed.
func TestOnlyA500OfAClientThatLeftEarlyIsRenamed(t *testing.T) {
	gone, leaveIt := context.WithCancel(context.Background())
	leaveIt()
	late, end := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer end()
	states := map[string]struct {
		ctx context.Context
		age time.Duration
	}{
		"there":                   {context.Background(), 0},
		"left early":              {gone, 0},
		"left just inside":        {gone, leftWithin - time.Second},
		"gone at the limit":       {gone, leftWithin},
		"gone at the console's":   {gone, 10 * time.Second},
		"gone at the gateway's":   {gone, 30 * time.Second},
		"own deadline (chi's 30)": {late, 0},
	}
	for name, state := range states {
		for _, status := range []int{200, 204, 304, 400, 401, 403, 404, 409, 422, 429, 499, 500, 501, 502, 503, 504, 507} {
			a := &answer{ResponseWriter: httptest.NewRecorder(), request: state.ctx, start: time.Now().Add(-state.age), leftWithin: leftWithin}
			a.WriteHeader(status)
			want := strconv.Itoa(status)
			if status == 500 && (name == "left early" || name == "left just inside") {
				want = "499"
			}
			if got := countedCode(context.WithValue(context.Background(), answerKey{}, a)); got != want {
				t.Errorf("%s, %d written: counted as %s, want %s", name, status, got, want)
			}
		}
	}
}

// A client that only closed its sending side reads as gone to net/http and can still read: what it reads is the 500.
func TestNothingSendsA499(t *testing.T) {
	m := New("test")
	srv := served(t, m, func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		http.Error(w, "context canceled", http.StatusInternalServerError)
	})
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "GET /read HTTP/1.1\r\nHost: kubeast\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	if err := conn.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	raw, err := io.ReadAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(raw), "HTTP/1.1 500 Internal Server Error\r\n") || strings.Contains(string(raw), "499") {
		t.Fatalf("the client read %q", raw)
	}
	countedAs(t, m, "get", "/read", "499")
}

// only is a reader io.Copy has the writer's ReadFrom read, since it can do nothing but Read.
func only(s string) io.Reader { return struct{ io.Reader }{strings.NewReader(s)} }

// promhttpOnly is Middleware as it was with promhttp's own writers: what the metrics said then they say now.
func promhttpOnly(m *Metrics, next http.Handler) http.Handler {
	opt := promhttp.WithLabelFromCtx("route", m.route)
	return promhttp.InstrumentHandlerInFlight(m.inFlight,
		promhttp.InstrumentHandlerDuration(m.duration, promhttp.InstrumentHandlerCounter(m.requests, next, opt), opt))
}

// counting is /read behind one of the two middlewares, with its own registry.
func counting(promhttpsOwn bool, h http.HandlerFunc) (*Metrics, http.Handler) {
	m := New("test")
	m.Route = ChiRoute
	r := chi.NewRouter()
	if promhttpsOwn {
		r.Use(func(next http.Handler) http.Handler { return promhttpOnly(m, next) })
	} else {
		r.Use(m.Middleware)
	}
	r.Handle("/read", h)
	return m, r
}

func TestWhatAClientThatStaysIsSentAndCountedAsIsWhatItWasWithPromhttpsWriters(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"nothing":       func(http.ResponseWriter, *http.Request) {},
		"write":         func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "a") },
		"write, header": func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "a"); w.WriteHeader(503) },
		"two headers":   func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404); w.WriteHeader(500) },
		"flush":         func(w http.ResponseWriter, _ *http.Request) { w.(http.Flusher).Flush() },
		"flush, header": func(w http.ResponseWriter, _ *http.Request) { w.(http.Flusher).Flush(); w.WriteHeader(500) },
		"copy":          func(w http.ResponseWriter, _ *http.Request) { _, _ = io.Copy(w, only("a")) },
		"copy, header": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.Copy(w, only("a"))
			w.WriteHeader(500)
		},
		"empty copy":       func(w http.ResponseWriter, _ *http.Request) { _, _ = io.Copy(w, only("")) },
		"early hints":      func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(103); w.WriteHeader(201) },
		"early hints only": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(103); _, _ = io.WriteString(w, "a") },
		"a 500":            func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) },
		"a panic":          func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) },
		"upgrade": func(w http.ResponseWriter, _ *http.Request) {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				panic(err)
			}
			_, _ = io.WriteString(conn, "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n")
			_ = conn.Close()
		},
	} {
		var lines, sent [2]string
		for i, promhttpsOwn := range []bool{false, true} {
			m, r := counting(promhttpsOwn, h)
			var handled sync.WaitGroup // srv.Close does not wait for the handler of a hijacked connection
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				defer handled.Done()
				r.ServeHTTP(w, req)
			}))
			srv.Config.ErrorLog = quiet()
			srv.Start()
			for _, method := range []string{"GET", "POST", "HEAD", "PURGE"} {
				handled.Add(1)
				sent[i] += rawAnswer(t, srv, method)
			}
			handled.Wait()
			srv.Close()
			lines[i] = strings.Join(counted(t, m), "\n")
		}
		if lines[0] != lines[1] {
			t.Errorf("%s: counted\n%s\nwith promhttp's writers\n%s", name, lines[0], lines[1])
		}
		if sent[0] != sent[1] {
			t.Errorf("%s: sent\n%s\nwith promhttp's writers\n%s", name, sent[0], sent[1])
		}
	}
}

func TestEveryStatusIsCountedAsPromhttpCountsIt(t *testing.T) {
	var lines [2]string
	for i, promhttpsOwn := range []bool{false, true} {
		status := 0
		m, r := counting(promhttpsOwn, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
		for status = 100; status <= 999; status++ {
			r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/read", nil))
		}
		lines[i] = strings.Join(counted(t, m), "\n")
	}
	if lines[0] != lines[1] {
		t.Fatalf("counted\n%s\nwith promhttp's writers\n%s", lines[0], lines[1])
	}
}

// rawAnswer is the bytes one request is answered with, but for the Date.
func rawAnswer(t *testing.T, srv *httptest.Server, method string) string {
	t.Helper()
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	_, _ = io.WriteString(conn, method+" /read HTTP/1.1\r\nHost: kubeast\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
	raw, _ := io.ReadAll(conn) // an aborted handler's connection may end in a reset
	return regexp.MustCompile(`Date: [^\r]+\r\n`).ReplaceAllString(string(raw), "")
}

// The exposition itself, HELP and TYPE and label names included, for one request of each kind.
func TestTheExpositionHasNoOtherName(t *testing.T) {
	m := New("test")
	m.Route = ChiRoute
	r := chi.NewRouter()
	r.Use(m.Middleware)
	r.Get("/a/{id}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	gone, leaveIt := context.WithCancel(context.Background())
	leaveIt()
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/a/1", nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/a/1", nil).WithContext(gone))
	var got []string
	for _, line := range strings.Split(scrape(t, m), "\n") {
		if strings.Contains(line, "kubeast_") && !strings.Contains(line, "_bucket{") && !strings.Contains(line, "_sum{") {
			got = append(got, line)
		}
	}
	want := `# HELP kubeast_http_request_duration_seconds HTTP request duration in seconds, by route pattern and status code.
# TYPE kubeast_http_request_duration_seconds histogram
kubeast_http_request_duration_seconds_count{code="499",method="get",route="/a/{id}",service="test"} 1
kubeast_http_request_duration_seconds_count{code="500",method="get",route="/a/{id}",service="test"} 1
# HELP kubeast_http_requests_in_flight HTTP requests currently being handled.
# TYPE kubeast_http_requests_in_flight gauge
kubeast_http_requests_in_flight{service="test"} 0
# HELP kubeast_http_requests_total HTTP requests handled, by route pattern and status code.
# TYPE kubeast_http_requests_total counter
kubeast_http_requests_total{code="499",method="get",route="/a/{id}",service="test"} 1
kubeast_http_requests_total{code="500",method="get",route="/a/{id}",service="test"} 1`
	if strings.Join(got, "\n") != want {
		t.Fatalf("exposition\n%s\nwant\n%s", strings.Join(got, "\n"), want)
	}
}

// An event stream reaches its client line by line and an upgraded connection carries both ways, on a real connection.
func TestStreamsAndUpgradesGoThroughTheAnswer(t *testing.T) {
	m := New("test")
	first := make(chan struct{})
	copied := make(chan int64, 1)
	srv := served(t, m, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("as") {
		case "stream":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: 1\n\n")
			w.(http.Flusher).Flush()
			select { // held until the client has read the first event
			case <-first:
			case <-r.Context().Done():
			}
			_, _ = io.WriteString(w, "data: 2\n\n")
		case "upgrade":
			conn, buf, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.Close()
			line, _ := buf.ReadString('\n')
			_, _ = io.WriteString(conn, "echo "+line)
		case "copy":
			n, err := w.(io.ReaderFrom).ReadFrom(strings.NewReader(strings.Repeat("x", 1<<20)))
			if err != nil {
				t.Error(err)
			}
			copied <- n
		case "controller":
			rc := http.NewResponseController(w)
			if err := rc.SetWriteDeadline(time.Now().Add(time.Minute)); err != nil {
				t.Errorf("SetWriteDeadline: %v", err)
			}
			if err := rc.Flush(); err != nil {
				t.Errorf("Flush: %v", err)
			}
		}
	})

	client := srv.Client()
	client.Timeout = 10 * time.Second
	res, err := client.Get(srv.URL + "/read?as=stream")
	if err != nil {
		t.Fatal(err)
	}
	events := bufio.NewReader(res.Body)
	if line, err := events.ReadString('\n'); err != nil || line != "data: 1\n" {
		t.Fatalf("first event %q, %v", line, err)
	}
	close(first)
	rest, err := io.ReadAll(events)
	_ = res.Body.Close()
	if err != nil || string(rest) != "\ndata: 2\n\n" {
		t.Fatalf("then %q, %v", rest, err)
	}

	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	_, _ = io.WriteString(conn, "GET /read?as=upgrade HTTP/1.1\r\nHost: kubeast\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\nhello\n")
	if raw, err := io.ReadAll(conn); err != nil || string(raw) != "echo hello\n" {
		t.Fatalf("over the upgraded connection %q, %v", raw, err)
	}

	for _, as := range []string{"copy", "controller"} {
		res, err := client.Get(srv.URL + "/read?as=" + as)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if err != nil || (as == "copy" && (len(body) != 1<<20 || <-copied != 1<<20)) {
			t.Fatalf("%s: %d bytes, %v", as, len(body), err)
		}
	}
}

// copier is a writer with a copy of its own, as the server's writer has.
type copier struct {
	http.ResponseWriter
	took int64
}

func (c *copier) ReadFrom(src io.Reader) (n int64, err error) {
	c.took, err = io.Copy(io.Discard, src)
	return c.took, err
}

func TestACopyIsTheWritersOwn(t *testing.T) {
	c := &copier{ResponseWriter: httptest.NewRecorder()}
	a := &answer{ResponseWriter: c, request: context.Background(), start: time.Now(), leftWithin: leftWithin}
	if n, err := io.Copy(a, only("abc")); n != 3 || err != nil || c.took != 3 || a.status != http.StatusOK {
		t.Fatalf("copied %d, %v; the writer's own copy took %d, status %d", n, err, c.took, a.status)
	}
}

// A writer that can do less than the server's own is not made to look as if it wrote.
func TestAnAnswerOverAPlainWriter(t *testing.T) {
	rec := httptest.NewRecorder()
	a := &answer{ResponseWriter: struct{ http.ResponseWriter }{rec}, request: context.Background(), start: time.Now(), leftWithin: leftWithin}
	a.Flush()
	if _, _, err := a.Hijack(); !errors.Is(err, http.ErrNotSupported) || a.wrote {
		t.Fatalf("Hijack = %v, wrote = %v", err, a.wrote)
	}
	if n, err := a.ReadFrom(strings.NewReader("abc")); n != 3 || err != nil || rec.Body.String() != "abc" || a.status != http.StatusOK {
		t.Fatalf("ReadFrom = %d, %v; body %q, status %d", n, err, rec.Body.String(), a.status)
	}
}

// screenWait is an axios call's own time in ms, as the screens' sources write one: 30000, 30_000 or 30 * 1000.
const screenWait = `\btimeout: ([\d_]+(?: \* [\d_]+)*)`

// wholeNumber is a number as a source writes it: "_" between its digits, or a product.
func wholeNumber(literal string) (int, error) {
	product := 1
	for _, factor := range strings.Split(literal, "*") {
		n, err := strconv.Atoi(strings.ReplaceAll(strings.TrimSpace(factor), "_", ""))
		if err != nil {
			return 0, fmt.Errorf("%q: %w", literal, err)
		}
		product *= n
	}
	return product, nil
}

func TestAScreensWaitIsReadAsItIsWritten(t *testing.T) {
	for source, want := range map[string]int{
		"  timeout: 10000, // ten seconds": 10000,
		"{ timeout: 90_000 })":             90000,
		"{ timeout: 1_200_000 }":           1200000,
		"timeout: 20 * 1000,":              20000,
		"timeout: 2 * 60 * 1_000,":         120000,
		"timeout: 300 }":                   300,
	} {
		hit := regexp.MustCompile(screenWait).FindStringSubmatch(source)
		if hit == nil {
			t.Errorf("%s: not found", source)
			continue
		}
		if got, err := wholeNumber(hit[1]); got != want || err != nil {
			t.Errorf("%s: %d, %v; want %d", source, got, err, want)
		}
	}
	for _, not := range []string{"timeout: LIMIT,", "requestTimeout: 500", "timeout = 500"} {
		if hit := regexp.MustCompile(screenWait).FindStringSubmatch(not); hit != nil {
			t.Errorf("%s: read as %v", not, hit)
		}
	}
}

// The limit is under half of every wait that ends a request the way its client leaving does, so a wait cut short of its
// time by what came before the handler (a full accept queue, a browser's own queue) is still past it.
func TestTheLimitIsUnderHalfOfEveryWait(t *testing.T) {
	const root = "../../../"
	waits := map[string]time.Duration{}
	read := func(pattern, path string, unit time.Duration) {
		t.Helper()
		paths, err := filepath.Glob(root + path)
		if err != nil || len(paths) == 0 {
			t.Fatalf("%s: %v, %v", path, paths, err)
		}
		found := 0
		for _, p := range paths {
			raw, err := os.ReadFile(p)
			if err != nil {
				t.Fatal(err)
			}
			for _, hit := range regexp.MustCompile(pattern).FindAllStringSubmatch(string(raw), -1) {
				n, err := wholeNumber(hit[1])
				if err != nil {
					t.Fatal(err)
				}
				found++
				waits[strings.TrimPrefix(p, root)+" "+strings.TrimSpace(hit[0])] = time.Duration(n) * unit
			}
		}
		if found == 0 {
			t.Fatalf("%s in %s: none found", pattern, path)
		}
	}
	read(screenWait, "frontend/src/services/api/*.ts", time.Millisecond)
	read(`proxy_read_timeout (\d+)s`, "helm/kubeast/files/nginx.conf", time.Second)
	for _, main := range []string{
		"auth-service-go/cmd/server/main.go", "k8s-service-go/cmd/server/conn_buffers.go",
		"session-service-go/cmd/server/main.go", "tool-server/main.go",
	} {
		read(`\bReadTimeout: +(\d+) \* time\.Second`, "services/"+main, time.Second)
	}
	for where, wait := range waits {
		if leftWithin*2 > wait {
			t.Errorf("%s: %v, and a client counts as left up to %v", where, wait, leftWithin)
		}
	}
}

// KubeastHighErrorRate counts 5xx over everything: a 499 is in the total and not among the errors.
func TestTheErrorRateAlertDoesNotCountA499(t *testing.T) {
	raw, err := os.ReadFile("../../../helm/kubeast/templates/prometheusrule.yaml")
	if err != nil {
		t.Fatal(err)
	}
	rule := regexp.MustCompile(`(?s)- alert: KubeastHighErrorRate\s+expr: \|(.*?)for:`).FindStringSubmatch(string(raw))
	if rule == nil {
		t.Fatal("no KubeastHighErrorRate in prometheusrule.yaml")
	}
	got := strings.Join(strings.Fields(rule[1]), " ")
	want := `sum by (service) (rate(kubeast_http_requests_total{code=~"5.."}[5m])) / sum by (service) (rate(kubeast_http_requests_total[5m])) > {{ .Values.metrics.prometheusRule.errorRatio }}`
	if got != want {
		t.Fatalf("the alert's expression is\n%s\nwant\n%s", got, want)
	}
	errorsOf := regexp.MustCompile("^(?:" + regexp.MustCompile(`code=~"([^"]+)"`).FindStringSubmatch(got)[1] + ")$")
	for code, counts := range map[string]bool{"499": false, "404": false, "200": false, "500": true, "503": true} {
		if errorsOf.MatchString(code) != counts {
			t.Errorf("code %s among the errors: %v, want %v", code, !counts, counts)
		}
	}
}
