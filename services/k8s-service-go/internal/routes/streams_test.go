package routes

import (
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/handler"
	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/ws"
)

// The terminals and the followed logs, as the screens and API clients open them.
var streamRoutes = []string{
	"GET /api/v1/namespaces/{namespace}/pods/{name}/exec/ws",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/logfiles/stream",
	"GET /api/v1/namespaces/{namespace}/pods/{name}/logs/stream",
	"GET /api/v1/nodes/{name}/debug-shell/ws",
}

func streamOnlyRouter() *chi.Mux {
	r := chi.NewRouter()
	r.Group(func(g chi.Router) { RegisterStreams(g, &handler.Handler{}) })
	return r
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func TestTheStreamRoutesAreTheTerminalsAndTheFollowedLogsAndTheServiceStillServesThem(t *testing.T) {
	streams := map[string]bool{}
	walkRoutes(t, streamOnlyRouter(), func(method, route string) { streams[method+" "+route] = true })
	if got := sortedKeys(streams); strings.Join(got, "\n") != strings.Join(streamRoutes, "\n") {
		t.Fatalf("RegisterStreams serves\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(streamRoutes, "\n"))
	}
	r := chi.NewRouter()
	Register(r, &handler.Handler{}, ws.NewMultiplexer(nil))
	all := map[string]bool{}
	walkRoutes(t, r, func(method, route string) { all[method+" "+route] = true })
	for _, route := range streamRoutes {
		if !all[route] {
			t.Errorf("Register no longer serves %s", route)
		}
	}
}

// --- The gateway in front: each stream the screens open reaches a stream route through a location that keeps it open.

type nginxLocation struct {
	modifier string // "", "=", "^~", "~", "~*"
	pattern  string
	body     string
}

var locationHead = regexp.MustCompile(`location\s+(=|\^~|~\*|~)?\s*(\S+)\s*\{`)

func nginxLocations(t *testing.T) []nginxLocation {
	t.Helper()
	raw, err := os.ReadFile("../../../../helm/kubeast/files/nginx.conf")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	var out []nginxLocation
	for _, m := range locationHead.FindAllStringSubmatchIndex(src, -1) {
		depth, end := 1, m[1]
		for ; end < len(src) && depth > 0; end++ {
			switch src[end] {
			case '{':
				depth++
			case '}':
				depth--
			}
		}
		modifier := ""
		if m[2] >= 0 {
			modifier = src[m[2]:m[3]]
		}
		out = append(out, nginxLocation{modifier: modifier, pattern: src[m[4]:m[5]], body: src[m[1]:end]})
	}
	return out
}

// pick is nginx's choice for path: an exact match, else the longest prefix unless a regex (in file order) matches,
// unless that prefix has "^~" (ngx_http_core_module "location").
func pick(t *testing.T, locs []nginxLocation, path string) nginxLocation {
	t.Helper()
	var prefix *nginxLocation
	for i, l := range locs {
		switch l.modifier {
		case "=":
			if l.pattern == path {
				return l
			}
		case "", "^~":
			if strings.HasPrefix(path, l.pattern) && (prefix == nil || len(l.pattern) > len(prefix.pattern)) {
				prefix = &locs[i]
			}
		}
	}
	if prefix == nil || prefix.modifier != "^~" {
		for _, l := range locs {
			if l.modifier == "~" && regexp.MustCompile(l.pattern).MatchString(path) {
				return l
			}
		}
	}
	if prefix == nil {
		t.Fatalf("no location for %s", path)
	}
	return *prefix
}

var rewriteLine = regexp.MustCompile(`rewrite\s+(\S+)\s+(\S+)\s+break;`)

// upstreamPath is the path the location sends on: its first rewrite that matches, else the request's own path
// (proxy_pass without a URI part) — the locations below proxy_pass to the upstream name only.
func upstreamPath(l nginxLocation, path string) string {
	for _, m := range rewriteLine.FindAllStringSubmatch(l.body, -1) {
		re := regexp.MustCompile(m[1])
		if re.MatchString(path) {
			return re.ReplaceAllString(path, strings.ReplaceAll(m[2], "$1", "${1}"))
		}
	}
	return path
}

func TestEachStreamTheScreensOpenReachesAStreamRouteThroughALocationThatKeepsItOpen(t *testing.T) {
	locs := nginxLocations(t)
	stream := streamOnlyRouter()
	for _, path := range []string{
		// as the screens open them (PodExecTerminal, PodLogsTab, LogFilesView, NodeShellTerminal)
		"/api/v1/cluster/namespaces/default/pods/web-0/exec/ws",
		"/api/v1/cluster/namespaces/default/pods/web-0/logs/stream",
		"/api/v1/cluster/namespaces/default/pods/web-0/logfiles/stream",
		"/api/v1/cluster/nodes/node-1/debug-shell/ws",
		// as API clients open a pod's streams
		"/api/v1/namespaces/default/pods/web-0/exec/ws",
		"/api/v1/namespaces/default/pods/web-0/logs/stream",
		"/api/v1/namespaces/default/pods/web-0/logfiles/stream",
	} {
		l := pick(t, locs, path)
		if !strings.Contains(l.body, "proxy_read_timeout 3600s") {
			t.Errorf("%s goes through location %s %s, which does not keep a quiet stream open", path, l.modifier, l.pattern)
		}
		if !strings.Contains(l.body, "proxy_pass http://k8s-service;") {
			t.Errorf("%s goes through location %s %s, which does not send it on to k8s-service as it came", path, l.modifier, l.pattern)
		}
		sent := upstreamPath(l, path)
		if !stream.Match(chi.NewRouteContext(), http.MethodGet, sent) {
			t.Errorf("%s reaches k8s-service as %s, which a stream server does not serve", path, sent)
		}
	}
}
