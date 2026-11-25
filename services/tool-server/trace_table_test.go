package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/junginho0901/kubeast/services/pkg/redact"
)

// modelResultChars is the length of a tool result the model reads unless its config says another (ai-service
// limits.TOOL_RESULT_CHARS).
const modelResultChars = 6000

// asTheModelReads is a JSON answer as ai-service hands it on: json.dumps(indent=2, ensure_ascii=False).
func asTheModelReads(t *testing.T, answer string) string {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(answer))
	dec.UseNumber()
	var v interface{}
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, answer)
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// made is one span of a made-up trace; at and ms are milliseconds from the trace's start and the span's length.
type made struct {
	id, parent, service, kind, name string
	at, ms                          float64
	status, message                 string
	attrs                           map[string]string
}

var traceStart = time.Date(2026, 11, 20, 4, 28, 31, 120_000_000, time.UTC)

// traceReply is what k8s-service answers for a trace: errors first, then by start.
func traceReply(t *testing.T, hidden int, spans []made) string {
	t.Helper()
	var errored, rest []map[string]interface{}
	for _, s := range spans {
		m := map[string]interface{}{
			"spanId": s.id, "service": s.service, "namespace": "shop", "name": s.name, "kind": s.kind, "durationMs": s.ms,
			"start": traceStart.Add(time.Duration(s.at * 1e6)).Format(time.RFC3339Nano), "status": "UNSET",
		}
		if s.parent != "" {
			m["parentSpanId"] = s.parent
		}
		if s.attrs != nil {
			m["attributes"] = s.attrs
		}
		if s.message != "" {
			m["statusMessage"] = s.message
		}
		if s.status != "" {
			m["status"] = s.status
			errored = append(errored, m)
			continue
		}
		rest = append(rest, m)
	}
	b, err := json.Marshal(map[string]interface{}{
		"traceId": madeTraceID, "total": len(spans) + hidden, "hidden": hidden, "errors": len(errored), "truncated": false,
		"spans": append(errored, rest...),
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

const madeTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"

// httpAttrs and rpcAttrs are the attributes auto-instrumentation puts on a span, at their usual number and length.
func httpAttrs(route, peer string) map[string]string {
	return map[string]string{
		"http.request.method": "GET", "http.response.status_code": "200", "http.route": route, "url.scheme": "http", "url.path": route,
		"user_agent.original": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
		"server.address":      peer, "server.port": "8080", "network.protocol.version": "1.1", "network.peer.address": "10.244.3.17",
		"network.peer.port": "50312", "session.id": "2d3c1f0e-7f35-4a51-9d0a-6e8b1c7a9f42",
	}
}

func rpcAttrs(service, method, peer string) map[string]string {
	return map[string]string{
		"rpc.system": "grpc", "rpc.service": service, "rpc.method": method, "rpc.grpc.status_code": "0", "server.address": peer,
		"server.port": "8080", "network.peer.address": "10.96.114.200", "network.peer.port": "8080", "network.type": "ipv4",
		"app.request.id": "0b7f7d52-8a6f-4f5e-a1b8-0f8f2a4c9d11", "session.id": "2d3c1f0e-7f35-4a51-9d0a-6e8b1c7a9f42",
	}
}

func dbAttrs(system, peer, statement string) map[string]string {
	return map[string]string{
		"db.system": system, "db.name": "catalog", "db.statement": statement, "db.user": "catalog", "server.address": peer, "server.port": "5432",
		"network.transport": "tcp", "network.peer.address": "10.96.80.12", "db.operation": "SELECT",
	}
}

// slowHopTrace: 24 spans of one request. The call from storefront to catalog takes 701.4 ms at the client and 3.1 ms at
// the server, and is among the last to start; a call to quote never reaches a server.
func slowHopTrace() []made {
	return []made{
		{id: "a1", service: "edge", kind: "SERVER", name: "ingress", at: 0, ms: 731.2, attrs: httpAttrs("/product/OLJCESPC7Z", "shop.example")},
		{id: "a2", parent: "a1", service: "edge", kind: "CLIENT", name: "router storefront egress", at: 0.4, ms: 730.5, attrs: httpAttrs("/product/OLJCESPC7Z", "storefront")},
		{id: "a3", parent: "a2", service: "storefront", kind: "SERVER", name: "GET /product/{productId}", at: 1.1, ms: 729, attrs: httpAttrs("/product/{productId}", "storefront")},
		{id: "a4", parent: "a3", service: "storefront", kind: "INTERNAL", name: "executing api route (pages) /api/products/{productId}", at: 1.5, ms: 727.6, attrs: map[string]string{"next.route": "/api/products/{productId}", "next.span_type": "Node.runHandler"}},
		{id: "b1", parent: "a4", service: "storefront", kind: "CLIENT", name: "grpc.shop.CurrencyService/Convert", at: 2, ms: 3.2, attrs: rpcAttrs("shop.CurrencyService", "Convert", "currency")},
		{id: "b2", parent: "b1", service: "currency", kind: "SERVER", name: "Currency/Convert", at: 2.6, ms: 0.4, attrs: rpcAttrs("shop.CurrencyService", "Convert", "currency")},
		{id: "c1", parent: "a4", service: "storefront", kind: "CLIENT", name: "grpc.shop.CartService/GetCart", at: 5.4, ms: 4.8, attrs: rpcAttrs("shop.CartService", "GetCart", "cart")},
		{id: "c2", parent: "c1", service: "cart", kind: "SERVER", name: "POST /shop.CartService/GetCart", at: 6, ms: 3.1, attrs: rpcAttrs("shop.CartService", "GetCart", "cart")},
		{id: "c3", parent: "c2", service: "cart", kind: "CLIENT", name: "HGET", at: 6.8, ms: 1.6, attrs: dbAttrs("redis", "cart-store", "HGET 2d3c1f0e-7f35-4a51-9d0a-6e8b1c7a9f42")},
		{id: "d1", parent: "a4", service: "storefront", kind: "CLIENT", name: "grpc.shop.RecommendationService/ListRecommendations", at: 10.4, ms: 8.9, attrs: rpcAttrs("shop.RecommendationService", "ListRecommendations", "recommendation")},
		{id: "d2", parent: "d1", service: "recommendation", kind: "SERVER", name: "/shop.RecommendationService/ListRecommendations", at: 11.3, ms: 7.4, attrs: rpcAttrs("shop.RecommendationService", "ListRecommendations", "recommendation")},
		{id: "d3", parent: "d2", service: "recommendation", kind: "INTERNAL", name: "get_product_list", at: 11.6, ms: 6.8, attrs: map[string]string{"app.products.count": "10", "app.filtered_products.count": "5"}},
		{id: "e1", parent: "a4", service: "storefront", kind: "CLIENT", name: "grpc.shop.AdService/GetAds", at: 19.5, ms: 2.7, attrs: rpcAttrs("shop.AdService", "GetAds", "ad")},
		{id: "e2", parent: "e1", service: "ad", kind: "SERVER", name: "shop.AdService/GetAds", at: 20.1, ms: 1.2, attrs: rpcAttrs("shop.AdService", "GetAds", "ad")},
		{id: "e3", parent: "e2", service: "ad", kind: "INTERNAL", name: "getAdsByCategory", at: 20.3, ms: 0.6, attrs: map[string]string{"app.ads.category": "telescopes", "app.ads.count": "2"}},
		{id: "f1", parent: "a4", service: "storefront", kind: "CLIENT", name: "grpc.shop.FlagService/ResolveBoolean", at: 22.4, ms: 1.9, attrs: rpcAttrs("shop.FlagService", "ResolveBoolean", "flags")},
		{id: "f2", parent: "f1", service: "flags", kind: "SERVER", name: "shop.FlagService/ResolveBoolean", at: 23, ms: 0.3, attrs: rpcAttrs("shop.FlagService", "ResolveBoolean", "flags")},
		{id: "g1", parent: "a4", service: "storefront", kind: "CLIENT", name: "grpc.shop.QuoteService/GetQuote", at: 24.5, ms: 1.1, status: "ERROR", message: "14 UNAVAILABLE: No connection established. Last error: connect ECONNREFUSED 10.96.44.7:8080", attrs: rpcAttrs("shop.QuoteService", "GetQuote", "quote")},
		{id: "h1", parent: "a4", service: "storefront", kind: "CLIENT", name: "grpc.shop.ProductCatalogService/GetProduct", at: 26, ms: 701.4, attrs: rpcAttrs("shop.ProductCatalogService", "GetProduct", "catalog")},
		{id: "h2", parent: "h1", service: "catalog", kind: "SERVER", name: "shop.ProductCatalogService/GetProduct", at: 377, ms: 3.1, attrs: rpcAttrs("shop.ProductCatalogService", "GetProduct", "catalog")},
		{id: "h3", parent: "h2", service: "catalog", kind: "CLIENT", name: "SELECT catalog.products", at: 377.6, ms: 1.9, attrs: dbAttrs("postgresql", "shop-db", "SELECT id, name, description, picture, price_units FROM catalog.products WHERE id = $1")},
		{id: "i1", parent: "a4", service: "storefront", kind: "INTERNAL", name: "render view", at: 728, ms: 0.8, attrs: map[string]string{"next.span_type": "BaseServer.renderToResponse"}},
		{id: "i2", parent: "a3", service: "storefront", kind: "INTERNAL", name: "resolve page components", at: 729.2, ms: 0.3, attrs: map[string]string{"next.span_type": "NextNodeServer.findPageComponents"}},
		{id: "i3", parent: "a3", service: "storefront", kind: "INTERNAL", name: "start response", at: 729.6, ms: 0.1, attrs: map[string]string{"next.span_type": "NextNodeServer.startResponse"}},
	}
}

func withTraceTable(t *testing.T, value string) {
	t.Helper()
	t.Setenv("AI_TRACE_SPAN_TABLE", value)
	t.Setenv("AI_TOOL_RESULT_DETAILS", "")
	was := redactOpts
	redactOpts = redact.Options{Enabled: true, Disabled: map[string]bool{}}
	t.Cleanup(func() { redactOpts = was })
}

func openTrace(t *testing.T, reply string) string {
	t.Helper()
	fakeK8sService(t, func(*http.Request) (int, string) { return 200, reply })
	out, err := handleTracesGet(ctxFor("c1"), args{"trace_id": madeTraceID}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// longTrace: n spans under one root, with names as long as instrumentation makes them; the 250th takes 900 ms.
func longTrace(n int) []made {
	spans := []made{{id: "root", service: "storefront", kind: "SERVER", name: "POST /checkout", at: 0, ms: 5000}}
	for i := 1; len(spans) < n; i++ {
		id := fmt.Sprintf("s%03d", i)
		ms := 2.0
		if i == 250 {
			ms = 900
		}
		spans = append(spans, made{id: id, parent: "root", service: "storefront", kind: "CLIENT", name: fmt.Sprintf("SELECT inventory.reservation_lines_%03d WHERE reservation_id IN (…) ORDER BY created_at LIMIT 100 OFFSET %d", i, i*100), at: float64(i) * 10, ms: ms, attrs: dbAttrs("postgresql", "inventory-db", "SELECT 1")})
	}
	return spans
}

// The answers of a traces_get before the table, as 981d53f65 gives them: the 24 spans, and 300 of which it keeps 100.
const (
	slowHopAnswerSHA   = "ba66debe91b338e22c25a9290f4f4d12c87af88543706960072dee090d48fa48"
	longTraceAnswerSHA = "c3697b8f8d68ff5f37baa049cd2ede58cd4767cd6767c9a8fadedfd29882c3c6"
)

func TestTraceTable_OffTheAnswerIsTheBytesItWas(t *testing.T) {
	for _, value := range []string{"", "false", "0", "off"} {
		withTraceTable(t, value)
		t.Setenv("AI_YAML_SPEC_FIRST", "true") // the other switch does nothing here
		out := openTrace(t, traceReply(t, 0, slowHopTrace()))
		if got := roundSHA(out); got != slowHopAnswerSHA {
			t.Errorf("switch %q: 24 spans answer %s, before %s", value, got, slowHopAnswerSHA)
		}
		read := asTheModelReads(t, out)
		if seen := strings.Count(string([]rune(read)[:modelResultChars]), `"spanId"`); seen != 7 {
			t.Errorf("the model reads the start of %d of 24 spans in the first %d of %d characters", seen, modelResultChars, utf8.RuneCountInString(read))
		}
		if got := roundSHA(openTrace(t, traceReply(t, 12, longTrace(300)))); got != longTraceAnswerSHA {
			t.Errorf("switch %q: 300 spans answer %s, before %s", value, got, longTraceAnswerSHA)
		}
	}
}

func tableOf(t *testing.T, out string) []string {
	t.Helper()
	var lines []string
	for _, v := range decode(t, out)["table"].([]interface{}) {
		lines = append(lines, v.(string))
	}
	return lines
}

func lineWith(lines []string, part string) string {
	for _, l := range lines {
		if strings.Contains(l, part) {
			return l
		}
	}
	return ""
}

func TestTraceTable_EverySpanOfATraceOf24AndTheSlowHop(t *testing.T) {
	withTraceTable(t, "true")
	out := openTrace(t, traceReply(t, 0, slowHopTrace()))
	read := asTheModelReads(t, out)
	t.Logf("24 spans: %d bytes, %d characters as the model reads it", len(out), utf8.RuneCountInString(read))
	if n := utf8.RuneCountInString(read); n > modelResultChars {
		t.Fatalf("the model reads %d of %d characters:\n%s", modelResultChars, n, read)
	}
	m, lines := decode(t, out), tableOf(t, out)
	if len(lines) != 24 || m["shown"] != float64(24) || m["errors"] != float64(1) || m["truncated"] != nil || m["hint"] != nil {
		t.Fatalf("%d lines: %s", len(lines), read)
	}
	if m["trace_id"] != madeTraceID || m["start"] != "2026-11-20T04:28:31.12Z" || m["trace_ms"] != 731.2 || m["spans"] != nil {
		t.Fatalf("result: %s", read)
	}
	if ns := fmt.Sprint(m["namespaces"]); ns != "[shop]" {
		t.Errorf("namespaces %s", ns)
	}
	for part, want := range map[string]string{
		"ingress":                          "0.0 | 731.2 | 0.7 |  | edge | SERVER | ingress",
		"router storefront egress":         "0.4 | 730.5 | 1.5 | 1.5 | edge → storefront | CLIENT | · router storefront egress",
		"executing api route":              "1.5 | 727.6 | 2.8 |  | storefront | INTERNAL | · · · executing api route (pages) /api/products/{productId}",
		"grpc.shop.ProductCatalogService":  "26.0 | 701.4 | 698.3 | 698.3 | storefront → catalog | CLIENT | · · · · grpc.shop.ProductCatalogService/GetProduct",
		" shop.ProductCatalogService":      "377.0 | 3.1 | 1.2 |  | catalog | SERVER | · · · · · shop.ProductCatalogService/GetProduct",
		"SELECT catalog.products":          "377.6 | 1.9 | 1.9 | none | catalog → shop-db | CLIENT | · · · · · · SELECT catalog.products",
		"HGET":                             "6.8 | 1.6 | 1.6 | none | cart → cart-store | CLIENT | · · · · · · HGET",
		"QuoteService":                     "24.5 | 1.1 | 1.1 | none | storefront → quote | CLIENT | · · · · grpc.shop.QuoteService/GetQuote [ERROR: 14 UNAVAILABLE: No connection established. Last error: connect ECONNREFUSED 10.96.44.7:8080]",
		"get_product_list":                 "11.6 | 6.8 | 6.8 |  | recommendation | INTERNAL | · · · · · · get_product_list",
		"grpc.shop.CartService/GetCart":    "5.4 | 4.8 | 1.7 | 1.7 | storefront → cart | CLIENT | · · · · grpc.shop.CartService/GetCart",
		"POST /shop.CartService/GetCart":   "6.0 | 3.1 | 1.5 |  | cart | SERVER | · · · · · POST /shop.CartService/GetCart",
		"grpc.shop.CurrencyService/Conver": "2.0 | 3.2 | 2.8 | 2.8 | storefront → currency | CLIENT | · · · · grpc.shop.CurrencyService/Convert",
	} {
		if got := lineWith(lines, part); got != want {
			t.Errorf("%s:\n got %q\nwant %q", part, got, want)
		}
	}
	// callers come before what they called, brothers by start
	for i, name := range []string{"ingress", "router storefront", "GET /product", "executing api", "CurrencyService", "Currency/Convert", "grpc.shop.CartService", "POST /shop.Cart", "HGET"} {
		if !strings.Contains(lines[i], name) {
			t.Errorf("line %d is %q, want %s", i, lines[i], name)
		}
	}
	for _, left := range []string{"user_agent", "Mozilla", "session.id", "2d3c1f0e", "db.statement", "spanId"} {
		if strings.Contains(out, left) {
			t.Errorf("an attribute is in the answer: %q", left)
		}
	}
	// the slow span is not among what the model read before, and the two ends of the slow hop are on one line now
	withTraceTable(t, "")
	if before := []rune(asTheModelReads(t, openTrace(t, traceReply(t, 0, slowHopTrace()))))[:modelResultChars]; strings.Contains(string(before), "701.4") {
		t.Error("the fixture's slow span was read before")
	}
}

func TestTraceTable_ALongTraceKeepsWhatTookTheTimeInTheSameLength(t *testing.T) {
	withTraceTable(t, "true")
	spans := longTrace(300)
	spans[120].status, spans[120].message = "ERROR", "canceling statement due to lock timeout"
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, strings.Replace(traceReply(t, 12, spans), `"truncated":false`, `"truncated":true`, 1)
	})
	t.Setenv("AI_TOOL_RESULT_DETAILS", "true")
	out, err := handleTracesGet(ctxFor("c1"), args{"trace_id": madeTraceID}, bearer())
	if err != nil {
		t.Fatal(err)
	}
	read := asTheModelReads(t, out)
	t.Logf("300 spans: %d bytes, %d characters as the model reads it", len(out), utf8.RuneCountInString(read))
	if n := utf8.RuneCountInString(read); n > modelResultChars {
		t.Fatalf("the model reads %d of %d characters", modelResultChars, n)
	}
	m, lines := decode(t, out), tableOf(t, out)
	for _, want := range []string{"POST /checkout", "reservation_lines_250", "reservation_lines_120"} {
		if lineWith(lines, want) == "" {
			t.Errorf("no line of %s", want)
		}
	}
	if line := lineWith(lines, "reservation_lines_120"); !strings.HasSuffix(line, "[ERROR: canceling statement due to lock timeout]") {
		t.Errorf("failed span: %q", line)
	}
	if m["truncated"] != true || m["hidden"] != float64(12) || m["shown"] != float64(len(lines)) || m["cut"] != fmt.Sprintf("%d of 300 spans in your scope", len(lines)) {
		t.Errorf("counts: %s", read)
	}
	hint := m["hint"].(string)
	if !strings.Contains(hint, fmt.Sprintf("%d spans are left out of the table, none with more than 2.0 ms", 300-len(lines))) || !strings.Contains(hint, "The trace was cut before that") {
		t.Errorf("hint %q", hint)
	}
	if note := m["note"].(string); !strings.Contains(note, "12 of 312") {
		t.Errorf("note %q", note)
	}
}

// Names as long as a line takes, full of what JSON escapes, in several namespaces: still within the length.
func TestTraceTable_TheLengthHoldsForAnyNames(t *testing.T) {
	withTraceTable(t, "true")
	spans := longTrace(300)
	for i := range spans {
		spans[i].service = strings.Repeat(`svc"\`, 30)
		spans[i].name = strings.Repeat("한글 \"이름\" \\ \n\t", 40)
		spans[i].status, spans[i].message = "ERROR", strings.Repeat(`line "one"`+"\n", 60)
		if i%9 == 8 {
			spans[i].parent = fmt.Sprintf("s%03d", i-1) // nine calls deep now and then
		}
	}
	reply := strings.Replace(traceReply(t, 3, spans), `"namespace":"shop"`, `"namespace":"other"`, 1)
	out := openTrace(t, reply)
	if n := utf8.RuneCountInString(asTheModelReads(t, out)); n > modelResultChars {
		t.Fatalf("the model reads %d of %d characters", modelResultChars, n)
	}
	lines := tableOf(t, out)
	if len(lines) == 0 || decode(t, out)["namespaces"] != nil {
		t.Fatalf("lines %d: %s", len(lines), out)
	}
	for _, l := range lines {
		if strings.ContainsAny(l, "\n\t") || !(strings.Contains(l, " | other/svc") || strings.Contains(l, " | shop/svc")) {
			t.Errorf("line %q", l)
		}
	}
}

// Spans that do not tie up: no parent here, a parent of their own, parents of each other, one ID twice, no time.
func TestTraceTable_SpansThatDoNotTieUpAreAllThere(t *testing.T) {
	withTraceTable(t, "true")
	out := openTrace(t, traceReply(t, 0, []made{
		{id: "x", parent: "gone", service: "a", kind: "SERVER", name: "orphan", at: 5, ms: 3},
		{id: "y", parent: "y", service: "a", kind: "INTERNAL", name: "its own parent", at: 1, ms: 1},
		{id: "p", parent: "q", service: "a", kind: "INTERNAL", name: "cycle one", at: 2, ms: 2},
		{id: "q", parent: "p", service: "a", kind: "INTERNAL", name: "cycle two", at: 2.5, ms: 1},
		{id: "x", parent: "x", service: "b", kind: "SERVER", name: "same ID", at: 6, ms: 1},
		{id: "", parent: "", service: "a", kind: "CONSUMER", name: "no ID", at: 0, ms: 1},
	}))
	lines := tableOf(t, out)
	if len(lines) != 6 {
		t.Fatalf("%d lines: %s", len(lines), out)
	}
	for _, want := range []string{"orphan", "its own parent", "cycle one", "cycle two", "same ID", "no ID"} {
		if lineWith(lines, want) == "" {
			t.Errorf("no line of %s", want)
		}
	}
	// a span without a start, as the answer's other tests make them, is not a failure
	fakeK8sService(t, func(*http.Request) (int, string) {
		return 200, `{"total":1,"spans":[{"spanId":"a","name":"op"}]}`
	})
	out, err := handleTracesGet(ctxFor("c1"), args{"trace_id": madeTraceID}, bearer())
	if err != nil || tableOf(t, out)[0] != "0.0 | 0.0 | 0.0 |  |  |  | op" || decode(t, out)["start"] != nil {
		t.Fatalf("%v %s", err, out)
	}
	// what is no span, and no span at all, answer as before
	for _, reply := range []string{`{"total":1,"spans":["x"]}`, `{"total":0,"spans":[]}`} {
		fakeK8sService(t, func(*http.Request) (int, string) { return 200, reply })
		if out, _ := handleTracesGet(ctxFor("c1"), args{"trace_id": madeTraceID}, bearer()); decode(t, out)["spans"] == nil {
			t.Errorf("%s answers %s", reply, out)
		}
	}
}

// A server that went on after its client stopped waiting, two server spans of one client, and children that overlap or
// run past their parent.
func TestTraceTable_TimesOfOddCalls(t *testing.T) {
	withTraceTable(t, "true")
	lines := tableOf(t, openTrace(t, traceReply(t, 0, []made{
		{id: "r", service: "web", kind: "SERVER", name: "root", at: 0, ms: 100},
		{id: "c", parent: "r", service: "web", kind: "CLIENT", name: "timed out", at: 10, ms: 50, status: "ERROR", message: "deadline exceeded"},
		{id: "s", parent: "c", service: "slow", kind: "SERVER", name: "went on", at: 11, ms: 300},
		{id: "d", parent: "r", service: "web", kind: "CLIENT", name: "twice", at: 40, ms: 40},
		{id: "t", parent: "d", service: "api", kind: "SERVER", name: "first", at: 41, ms: 10},
		{id: "u", parent: "d", service: "api", kind: "SERVER", name: "second", at: 55, ms: 12},
		{id: "k", parent: "r", service: "web", kind: "PRODUCER", name: "publish", at: 85, ms: 5, attrs: map[string]string{"messaging.destination.name": "orders"}},
		{id: "o", parent: "k", service: "worker", kind: "CONSUMER", name: "process", at: 500, ms: 20},
		{id: "e", service: "api", kind: "SERVER", name: "POST /pay", at: 600, ms: 4, status: "ERROR", attrs: map[string]string{"http.response.status_code": "500", "error.type": "Boom"}},
		{id: "f", parent: "e", service: "api", kind: "CLIENT", name: "connect", at: 601, ms: 1, status: "ERROR", message: "refused", attrs: map[string]string{"rpc.grpc.status_code": "0", "error.type": "ECONNREFUSED"}},
	})))
	for part, want := range map[string]string{
		"root":      "0.0 | 100.0 | 25.0 |  | web | SERVER | root", // 10–80 and 85–90 covered
		"timed out": "10.0 | 50.0 | 1.0 | -250.0 | web → slow | CLIENT | · timed out [ERROR: deadline exceeded]",
		"twice":     "40.0 | 40.0 | 18.0 | 18.0 | web → api | CLIENT | · twice",
		"publish":   "85.0 | 5.0 | 5.0 |  | web → orders | PRODUCER | · publish",
		"process":   "500.0 | 20.0 | 20.0 |  | worker | CONSUMER | · · process",
		// a failed span's code, where its message says nothing too
		"POST /pay": "600.0 | 4.0 | 3.0 |  | api | SERVER | POST /pay [ERROR 500]",
		"connect":   "601.0 | 1.0 | 1.0 | none | api | CLIENT | · connect [ERROR ECONNREFUSED: refused]",
	} {
		if got := lineWith(lines, part); got != want {
			t.Errorf("%s:\n got %q\nwant %q", part, got, want)
		}
	}
}

// Attributes are not in the table, and what a span's name or message holds is masked and counted as it is in the spans.
func TestTraceTable_NoCredentialOfASpanReachesTheModel(t *testing.T) {
	spans := []made{
		{id: "a", service: "web", kind: "SERVER", name: "GET /login", at: 0, ms: 5, attrs: map[string]string{"http.request.header.authorization": "Bearer plantedtoken0123456789abcdef", "enduser.id": "ann.planted@example.com"}},
		{id: "b", parent: "a", service: "web", kind: "CLIENT", name: "PUT " + plantedAWSKey, at: 1, ms: 2, status: "ERROR", message: "password: planted-db-pass-1", attrs: map[string]string{"server.address": "postgres://u:planted-db-pass-1@db:5432/app"}},
		{id: "c", parent: "a", service: "web", kind: "CLIENT", name: strings.Repeat("x", 80) + " call 010-2222-3333 now", at: 3, ms: 1, status: "ERROR", message: strings.Repeat("y", 100) + " ann.planted@example.com " + strings.Repeat("z", 40)},
	}
	count := func(on string, pii bool) (string, *redact.Stats) {
		withTraceTable(t, on)
		redactOpts.PII = pii
		toolServerForSecrets(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(traceReply(t, 0, spans))) })
		resp := callTool(t, "traces_get", map[string]interface{}{"trace_id": madeTraceID})
		if resp.Error != "" {
			t.Fatal(resp.Error)
		}
		return resp.Content, resp.Redacted
	}
	planted := append([]string{plantedAWSKey}, plantedValues...)
	on, stats := count("true", true)
	for _, v := range planted {
		if strings.Contains(on, v) {
			t.Errorf("%q is in the table: %s", v, on)
		}
	}
	lines := tableOf(t, on)
	if got := lineWith(lines, "REDACTED:aws_access_key"); !strings.Contains(got, "[ERROR: password: <REDACTED:password>]") {
		t.Errorf("masked line %q", got)
	}
	// the name's, the message's and the address's credentials, then a phone number and an e-mail address
	if stats == nil || stats.Kinds["key_name"] != 1 || stats.Kinds["aws_key"] != 1 || stats.Kinds["url_credentials"] != 1 || stats.Kinds["phone"] != 1 || stats.Kinds["email"] != 1 || stats.Count != 5 {
		t.Errorf("masked %+v", stats)
	}
	// the spans themselves mask the same, and their attributes besides
	off, stats := count("", true)
	for _, v := range planted {
		if strings.Contains(off, v) {
			t.Errorf("%q is in the spans: %s", v, off)
		}
	}
	if stats == nil || stats.Kinds["key_name"] != 1 || stats.Kinds["aws_key"] != 1 || stats.Kinds["authorization"] != 1 {
		t.Errorf("masked %+v", stats)
	}
}

// A made-up value of the shape of an AWS access key ID.
const plantedAWSKey = "AKIAPLANTED012345678"
