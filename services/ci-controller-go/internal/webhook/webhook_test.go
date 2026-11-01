package webhook

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The payload files in testdata are octokit/webhooks' examples
// (payload-examples/api.github.com, MIT, LICENSE.octokit-webhooks) at commit
// aa80c24a3f55 of 2026-10-04; the fields read here match GitHub's
// "Webhook events and payloads" of 2026-11-01.

var testSecret = []byte("kubeast-test-webhook-secret-0123456789")

func sign(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func payload(t testing.TB, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func verifier(t testing.TB, secrets ...[]byte) *Verifier {
	t.Helper()
	if len(secrets) == 0 {
		secrets = [][]byte{testSecret}
	}
	v, err := NewVerifier(secrets...)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// TestGitHubTestVector is the pair GitHub's "Validating webhook deliveries"
// gives to check an implementation.
func TestGitHubTestVector(t *testing.T) {
	v := &Verifier{secrets: [][]byte{[]byte("It's a Secret to Everybody")}}
	sig := "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
	if !v.SignatureValid(sig, []byte("Hello, World!")) {
		t.Fatal("GitHub's test signature does not validate")
	}
	for _, bad := range []string{
		strings.Replace(sig, "7571", "7572", 1),
		strings.TrimPrefix(sig, "sha256="),
		"sha1=" + strings.TrimPrefix(sig, "sha256="),
		sig[:len(sig)-2],
		strings.ToUpper(sig),
		"",
	} {
		if v.SignatureValid(bad, []byte("Hello, World!")) {
			t.Errorf("signature %q validated", bad)
		}
	}
	if v.SignatureValid(sig, []byte("Hello, World!\n")) {
		t.Error("a changed body validated")
	}
}

// TestComparesInConstantTime keeps GitHub's rule "never use a plain ==
// operator" in the source: the signature is compared with hmac.Equal only.
func TestComparesInConstantTime(t *testing.T) {
	src, err := os.ReadFile("webhook.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	if !strings.Contains(s, "hmac.Equal(sig, mac.Sum(nil))") {
		t.Error("the signature is not compared with hmac.Equal")
	}
	for _, banned := range []string{"bytes.Equal", "subtle.", "string(sig) ==", "== hexSig", "hexSig =="} {
		if strings.Contains(s, banned) {
			t.Errorf("webhook.go contains %q", banned)
		}
	}
}

func TestNewVerifierRefusesNoOrShortSecret(t *testing.T) {
	if _, err := NewVerifier(); err == nil {
		t.Error("no secret accepted")
	}
	if _, err := NewVerifier([]byte("short")); err == nil || !strings.Contains(err.Error(), "at least 32") {
		t.Errorf("short secret: %v", err)
	}
	v := verifier(t)
	if strings.Contains(v.String(), string(testSecret)) || strings.Contains(v.String(), "kubeast-test") {
		t.Error("String shows the secret")
	}
}

func TestSecretRotation(t *testing.T) {
	old := []byte("the-old-webhook-secret-0123456789abcdef")
	v := verifier(t, testSecret, old)
	body := []byte(`{}`)
	if !v.SignatureValid(sign(old, body), body) || !v.SignatureValid(sign(testSecret, body), body) {
		t.Fatal("a configured secret does not validate")
	}
	if v.SignatureValid(sign([]byte("another-secret-not-configured-0123456789"), body), body) {
		t.Fatal("an unknown secret validated")
	}
}

const delivery = "72d3162e-cc78-11e3-81ab-4c9367dc0958"

func TestCheckPayloads(t *testing.T) {
	v := verifier(t)
	check := func(event string, body []byte) Result {
		return v.Check(event, delivery, sign(testSecret, body), body)
	}

	push := check("push", payload(t, "push_with-new-branch.payload.json"))
	want := Event{Delivery: delivery, Kind: "push", Installation: 1, RepoID: 186853002, Repo: "Codertocat/Hello-World",
		Ref: "refs/heads/master", SHA: "6113728f27ae82c7b1a177c8d03f9e96e0adf246", Sender: "Codertocat"}
	if push.Outcome != Accepted || push.Event != want {
		t.Errorf("push = %+v\nwant %+v", push, want)
	}

	if r := check("push", payload(t, "push_with-installation.payload.json")); r.Outcome != Ignored || r.Reason != "deleted" {
		t.Errorf("deleted tag push = %+v, want ignored: deleted", r)
	}

	for _, f := range []string{"pull_request_opened.payload.json", "pull_request_synchronize.payload.json"} {
		r := check("pull_request", payload(t, f))
		e := r.Event
		if r.Outcome != Accepted || e.Kind != "pull_request" || e.Number != 2 || e.Ref != "refs/heads/master" ||
			e.SHA != "ec26c3e57ca3a959ca5aad62de7213c562f8c821" || e.HeadRef != "refs/pull/2/head" || e.Fork || e.RepoID != 186853002 {
			t.Errorf("%s = %+v", f, r)
		}
	}

	if r := check("pull_request", payload(t, "pull_request_closed.payload.json")); r.Outcome != Ignored || r.Reason != "action" {
		t.Errorf("closed pull request = %+v, want ignored: action", r)
	}
	if r := check("issues", []byte(`{"action":"opened"}`)); r.Outcome != Ignored || r.Reason != "event" {
		t.Errorf("issues = %+v, want ignored: event", r)
	}
	if r := check("ping", []byte(`{"zen":"Keep it logically awesome."}`)); r.Outcome != Ignored || r.Reason != "ping" {
		t.Errorf("ping = %+v", r)
	}
}

// fork rewrites the opened pull request's head repository.
func fork(t *testing.T, head any) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(payload(t, "pull_request_opened.payload.json"), &m); err != nil {
		t.Fatal(err)
	}
	m["pull_request"].(map[string]any)["head"].(map[string]any)["repo"] = head
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestForkPullRequests(t *testing.T) {
	v := verifier(t)
	for name, head := range map[string]any{
		"another repository": map[string]any{"id": 999, "full_name": "someone/Hello-World"},
		"deleted fork":       nil,
	} {
		body := fork(t, head)
		r := v.Check("pull_request", delivery, sign(testSecret, body), body)
		if r.Outcome != Accepted || !r.Event.Fork {
			t.Errorf("%s: %+v, want accepted as a fork", name, r)
		}
	}
}

func TestCheckRefusesBeforeReading(t *testing.T) {
	v := verifier(t)
	body := payload(t, "push_with-new-branch.payload.json")
	cases := map[string]struct {
		event, delivery, sig string
		body                 []byte
		reason               string
	}{
		"no signature":     {"push", delivery, "", body, "no-signature"},
		"other secret":     {"push", delivery, sign([]byte("not-the-secret-0123456789abcdef0123"), body), body, "bad-signature"},
		"body changed":     {"push", delivery, sign(testSecret, body), append([]byte(" "), body...), "bad-signature"},
		"no event header":  {"", delivery, sign(testSecret, body), body, "malformed"},
		"bad delivery id":  {"push", "../../etc", sign(testSecret, body), body, "malformed"},
		"not JSON":         {"push", delivery, sign(testSecret, []byte("{")), []byte("{"), "malformed"},
		"no repository":    {"push", delivery, sign(testSecret, []byte(`{"ref":"refs/heads/main","after":"6113728f27ae82c7b1a177c8d03f9e96e0adf246"}`)), []byte(`{"ref":"refs/heads/main","after":"6113728f27ae82c7b1a177c8d03f9e96e0adf246"}`), "malformed"},
		"short sha":        {"push", delivery, sign(testSecret, []byte(`{"ref":"refs/heads/main","after":"abc","repository":{"id":1,"full_name":"o/r"}}`)), []byte(`{"ref":"refs/heads/main","after":"abc","repository":{"id":1,"full_name":"o/r"}}`), "malformed"},
		"ref not a branch": {"push", delivery, sign(testSecret, []byte(`{"ref":"refs/notes/x","after":"6113728f27ae82c7b1a177c8d03f9e96e0adf246","repository":{"id":1,"full_name":"o/r"}}`)), []byte(`{"ref":"refs/notes/x","after":"6113728f27ae82c7b1a177c8d03f9e96e0adf246","repository":{"id":1,"full_name":"o/r"}}`), "malformed"},
	}
	for name, c := range cases {
		r := v.Check(c.event, c.delivery, c.sig, c.body)
		if r.Outcome != Rejected || r.Reason != c.reason {
			t.Errorf("%s: %+v, want rejected: %s", name, r, c.reason)
		}
	}
}

type fixture struct {
	h        *Handler
	queued   []Event
	rejected []Rejection
	full     bool
	now      time.Time
}

func newFixture(t *testing.T) *fixture {
	f := &fixture{now: time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC)}
	f.h = &Handler{
		Verifier:   verifier(t),
		Deliveries: NewDeliveries(),
		Enqueue: func(e Event) bool {
			if f.full {
				return false
			}
			f.queued = append(f.queued, e)
			return true
		},
		OnReject: func(r Rejection) { f.rejected = append(f.rejected, r) },
		Now:      func() time.Time { return f.now },
	}
	return f
}

func (f *fixture) send(method, event, id string, body []byte, edit func(*http.Request)) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, Path, bytes.NewReader(body))
	r.RemoteAddr = "192.30.252.10:51234"
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-GitHub-Event", event)
	r.Header.Set("X-GitHub-Delivery", id)
	r.Header.Set("X-Hub-Signature-256", sign(testSecret, body))
	if edit != nil {
		edit(r)
	}
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}

func TestHandlerAnswers(t *testing.T) {
	push := payload(t, "push_with-new-branch.payload.json")
	cases := []struct {
		name   string
		method string
		event  string
		body   []byte
		edit   func(*http.Request)
		setup  func(*fixture)
		status int
		text   string
		queued int
	}{
		{name: "push is queued", event: "push", body: push, status: 202, text: "queued", queued: 1},
		{name: "ping", event: "ping", body: []byte(`{}`), status: 200, text: "pong"},
		{name: "other event", event: "issues", body: []byte(`{}`), status: 202, text: "ignored: event"},
		{name: "closed pull request", event: "pull_request", body: payload(t, "pull_request_closed.payload.json"), status: 202, text: "ignored: action"},
		{name: "GET", method: "GET", event: "push", body: push, status: 405, text: "method"},
		{name: "form encoded", event: "push", body: push, edit: func(r *http.Request) { r.Header.Set("Content-Type", "application/x-www-form-urlencoded") }, status: 415, text: "content-type"},
		{name: "JSON with charset", event: "push", body: push, edit: func(r *http.Request) { r.Header.Set("Content-Type", "application/json; charset=utf-8") }, status: 202, text: "queued", queued: 1},
		{name: "no signature", event: "push", body: push, edit: func(r *http.Request) { r.Header.Del("X-Hub-Signature-256") }, status: 403, text: "no-signature"},
		{name: "wrong signature", event: "push", body: push, edit: func(r *http.Request) {
			r.Header.Set("X-Hub-Signature-256", sign([]byte("x-not-the-secret-0123456789abcdef0123"), push))
		}, status: 403, text: "bad-signature"},
		{name: "too large", event: "push", body: append(push, bytes.Repeat([]byte(" "), DefaultMaxBody)...), status: 413, text: "too-large"},
		{name: "queue full", event: "push", body: push, setup: func(f *fixture) { f.full = true }, status: 503, text: "queue-full"},
		{name: "source not allowed", event: "push", body: push, setup: func(f *fixture) { f.h.AllowedSources = []netip.Prefix{netip.MustParsePrefix("140.82.112.0/20")} }, status: 403, text: "source"},
		{name: "source allowed", event: "push", body: push, setup: func(f *fixture) { f.h.AllowedSources = []netip.Prefix{netip.MustParsePrefix("192.30.252.0/22")} }, status: 202, text: "queued", queued: 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			if c.setup != nil {
				c.setup(f)
			}
			method := c.method
			if method == "" {
				method = "POST"
			}
			w := f.send(method, c.event, delivery, c.body, c.edit)
			if w.Code != c.status || !strings.Contains(w.Body.String(), c.text) {
				t.Fatalf("answer %d %q, want %d %q", w.Code, w.Body.String(), c.status, c.text)
			}
			if len(f.queued) != c.queued {
				t.Fatalf("queued %d, want %d", len(f.queued), c.queued)
			}
			if c.status >= 400 {
				if len(f.rejected) != 1 || f.rejected[0].Status != c.status || f.rejected[0].Reason != c.text {
					t.Fatalf("rejections %+v", f.rejected)
				}
				if f.rejected[0].Source != netip.MustParseAddr("192.30.252.10") {
					t.Fatalf("source %v", f.rejected[0].Source)
				}
			}
		})
	}
}

func TestHandlerTakesADeliveryOnce(t *testing.T) {
	f := newFixture(t)
	push := payload(t, "push_with-new-branch.payload.json")
	if w := f.send("POST", "push", delivery, push, nil); w.Code != 202 {
		t.Fatal(w.Code)
	}
	w := f.send("POST", "push", delivery, push, nil)
	if w.Code != 202 || !strings.Contains(w.Body.String(), "duplicate") || len(f.queued) != 1 {
		t.Fatalf("second delivery: %d %q, queued %d", w.Code, w.Body.String(), len(f.queued))
	}
	f.now = f.now.Add(24*time.Hour + time.Second)
	if w := f.send("POST", "push", delivery, push, nil); w.Code != 202 || len(f.queued) != 2 {
		t.Fatalf("after 24 hours: %d, queued %d", w.Code, len(f.queued))
	}
}

// A delivery refused because the queue was full is not remembered, so its
// redelivery (same X-GitHub-Delivery) is taken.
func TestQueueFullDeliveryCanBeRedelivered(t *testing.T) {
	f := newFixture(t)
	push := payload(t, "push_with-new-branch.payload.json")
	f.full = true
	if w := f.send("POST", "push", delivery, push, nil); w.Code != 503 {
		t.Fatal(w.Code)
	}
	f.full = false
	if w := f.send("POST", "push", delivery, push, nil); w.Code != 202 || len(f.queued) != 1 {
		t.Fatalf("redelivery: %d, queued %d", w.Code, len(f.queued))
	}
}

func TestSourceBehindTrustedProxy(t *testing.T) {
	f := newFixture(t)
	f.h.ClientIPHeader = "CF-Connecting-IP"
	f.h.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	f.h.AllowedSources = []netip.Prefix{netip.MustParsePrefix("192.30.252.0/22")}
	push := payload(t, "push_with-new-branch.payload.json")

	// From the tunnel connector: its header names the source.
	w := f.send("POST", "push", delivery, push, func(r *http.Request) {
		r.RemoteAddr = "10.1.2.3:443"
		r.Header.Set("CF-Connecting-IP", "192.30.252.77")
	})
	if w.Code != 202 {
		t.Fatalf("via trusted proxy: %d %s", w.Code, w.Body.String())
	}
	// From anyone else the header is ignored.
	w = f.send("POST", "push", "other-delivery-id", push, func(r *http.Request) {
		r.RemoteAddr = "203.0.113.9:443"
		r.Header.Set("CF-Connecting-IP", "192.30.252.77")
	})
	if w.Code != 403 || f.rejected[0].Source != netip.MustParseAddr("203.0.113.9") {
		t.Fatalf("spoofed header: %d, rejections %+v", w.Code, f.rejected)
	}
}

func TestRateLimitPerSource(t *testing.T) {
	f := newFixture(t)
	f.h.Limit = NewSourceLimit(3)
	push := payload(t, "push_with-new-branch.payload.json")
	codes := []int{}
	for i := 0; i < 4; i++ {
		codes = append(codes, f.send("POST", "push", "d"+string(rune('a'+i)), push, nil).Code)
	}
	if codes[3] != 429 || codes[2] != 202 {
		t.Fatalf("codes %v, want the 4th refused", codes)
	}
	other := f.send("POST", "push", "de", push, func(r *http.Request) { r.RemoteAddr = "140.82.112.5:1" })
	if other.Code != 202 {
		t.Fatalf("another source: %d", other.Code)
	}
	f.now = f.now.Add(time.Minute)
	if w := f.send("POST", "push", "df", push, nil); w.Code != 202 {
		t.Fatalf("next minute: %d", w.Code)
	}
}

func TestSourceLimitBoundsItsMemory(t *testing.T) {
	l := &SourceLimit{PerMinute: 2, MaxSources: 3}
	now := time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC)
	for i := 1; i <= 3; i++ {
		if !l.Allow(netip.AddrFrom4([4]byte{10, 0, 0, byte(i)}), now) {
			t.Fatal("first deliveries refused")
		}
	}
	// New addresses past MaxSources share one count.
	a, b, c := l.Allow(netip.MustParseAddr("10.0.1.1"), now), l.Allow(netip.MustParseAddr("10.0.1.2"), now), l.Allow(netip.MustParseAddr("10.0.1.3"), now)
	if !a || !b || c || len(l.counts) != 3 {
		t.Fatalf("overflow: %v %v %v, %d addresses kept", a, b, c, len(l.counts))
	}
}

func TestDeliveriesExpireAndStayBounded(t *testing.T) {
	d := &Deliveries{TTL: time.Hour, Max: 3}
	t0 := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for i, id := range []string{"a", "b", "c", "d"} {
		d.Take(id, t0.Add(time.Duration(i)*time.Minute))
	}
	if d.Len() != 3 || d.Seen("a", t0.Add(5*time.Minute)) || !d.Seen("d", t0.Add(5*time.Minute)) {
		t.Fatalf("max: len %d", d.Len())
	}
	if d.Seen("b", t0.Add(time.Hour+time.Minute)) || !d.Seen("d", t0.Add(time.Hour+2*time.Minute)) {
		t.Fatal("ttl")
	}
	if d.Seen("d", t0.Add(time.Hour+3*time.Minute)) || d.Len() != 0 {
		t.Fatalf("all expired: len %d", d.Len())
	}
}

func TestParseMetaHooks(t *testing.T) {
	prefixes, err := ParseMetaHooks(payload(t, "github-meta-20261101.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(prefixes) != 9 || !inAny(prefixes, netip.MustParseAddr("192.30.252.10")) ||
		!inAny(prefixes, netip.MustParseAddr("2606:50c0::1")) || inAny(prefixes, netip.MustParseAddr("8.8.8.8")) {
		t.Fatalf("hooks %v", prefixes)
	}
	if _, err := ParseMetaHooks([]byte(`{"hooks":[]}`)); err != ErrNoHooks {
		t.Errorf("empty hooks: %v", err)
	}
	if _, err := ParseMetaHooks([]byte(`{"hooks":["192.30.252.0/33"]}`)); err == nil {
		t.Error("bad range accepted")
	}
}
