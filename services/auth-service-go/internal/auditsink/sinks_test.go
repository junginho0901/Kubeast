package auditsink

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func sampleEvents() []Event {
	t := time.Date(2026, 10, 5, 7, 1, 2, 0, time.UTC)
	return []Event{
		{ID: 41, Time: t, Service: "k8s", Action: "k8s.pod.delete", Result: "success", ActorEmail: "alice@example.com", TargetType: "pod", TargetID: "nginx", Cluster: "test2", Namespace: "default"},
		{ID: 42, Time: t.Add(time.Second), Service: "auth", Action: "access.request.create", Result: "failure", Error: "denied <x>", ActorEmail: "bob@example.com"},
	}
}

func TestFilter(t *testing.T) {
	ev := sampleEvents()
	cases := []struct {
		f    Filter
		want []int64
	}{
		{Filter{}, []int64{41, 42}},
		{Filter{Actions: []string{"k8s.*.delete"}}, []int64{41}},
		{Filter{Actions: []string{"access.*"}}, []int64{42}},
		{Filter{Results: []string{"failure"}}, []int64{42}},
		{Filter{Actions: []string{"*"}, Results: []string{"success"}}, []int64{41}},
		{Filter{Actions: []string{"admin.*"}}, nil},
	}
	for _, c := range cases {
		var got []int64
		for _, e := range c.f.Apply(ev) {
			got = append(got, e.ID)
		}
		if strings.Join(strs(got), ",") != strings.Join(strs(c.want), ",") {
			t.Errorf("%+v: got %v want %v", c.f, got, c.want)
		}
	}
	if err := (Filter{Results: []string{"ok"}}).validate(); err == nil {
		t.Error("unknown result must be refused")
	}
}

func strs(ids []int64) []string {
	var out []string
	for _, id := range ids {
		out = append(out, string(rune('0'+id%10)))
	}
	return out
}

type captured struct {
	mu   sync.Mutex
	reqs []*http.Request
	body [][]byte
}

func (c *captured) server(t *testing.T, status int) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		c.reqs = append(c.reqs, r)
		c.body = append(c.body, b)
		c.mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func webhook(t *testing.T, format, url string, secrets map[string]string, extra func(*SinkConfig)) Sink {
	t.Helper()
	sc := SinkConfig{Name: "w", Type: "webhook", Webhook: WebhookConfig{Format: format, URL: url}, secrets: secrets}
	if extra != nil {
		extra(&sc)
	}
	s, err := sc.build()
	if err != nil {
		t.Fatalf("%s: %v", format, err)
	}
	return s
}

func TestWebhookFormats(t *testing.T) {
	ev := sampleEvents()
	t.Run("json with signature", func(t *testing.T) {
		c := &captured{}
		srv := c.server(t, 200)
		if err := webhook(t, "json", srv.URL, map[string]string{"hmacSecret": "s3cret"}, nil).Send(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		var body struct {
			Source string  `json:"source"`
			Events []Event `json:"events"`
		}
		if err := json.Unmarshal(c.body[0], &body); err != nil || body.Source != "kubeast" || len(body.Events) != 2 || body.Events[1].ID != 42 {
			t.Fatalf("body %s (%v)", c.body[0], err)
		}
		m := hmac.New(sha256.New, []byte("s3cret"))
		m.Write(c.body[0])
		if got := c.reqs[0].Header.Get("X-Kubeast-Signature"); got != "sha256="+hex.EncodeToString(m.Sum(nil)) {
			t.Fatalf("signature %q", got)
		}
	})
	t.Run("slack escapes mrkdwn", func(t *testing.T) {
		c := &captured{}
		srv := c.server(t, 200)
		if err := webhook(t, "slack", "", map[string]string{"url": srv.URL}, nil).Send(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		var msg struct {
			Text   string `json:"text"`
			Blocks []struct {
				Text struct{ Text string } `json:"text"`
			} `json:"blocks"`
		}
		if err := json.Unmarshal(c.body[0], &msg); err != nil || len(msg.Blocks) != 2 {
			t.Fatalf("slack body %s (%v)", c.body[0], err)
		}
		if lines := msg.Blocks[1].Text.Text; !strings.Contains(lines, "k8s.pod.delete success") || !strings.Contains(lines, "denied &lt;x&gt;") {
			t.Fatalf("slack lines %q", lines)
		}
	})
	t.Run("teams adaptive card", func(t *testing.T) {
		c := &captured{}
		srv := c.server(t, 202)
		if err := webhook(t, "teams", "", map[string]string{"url": srv.URL}, nil).Send(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		var msg struct {
			Type        string `json:"type"`
			Attachments []struct {
				ContentType string `json:"contentType"`
				Content     struct {
					Type string           `json:"type"`
					Body []map[string]any `json:"body"`
				} `json:"content"`
			} `json:"attachments"`
		}
		if err := json.Unmarshal(c.body[0], &msg); err != nil || msg.Type != "message" || msg.Attachments[0].ContentType != "application/vnd.microsoft.card.adaptive" || msg.Attachments[0].Content.Type != "AdaptiveCard" || len(msg.Attachments[0].Content.Body) != 3 {
			t.Fatalf("teams body %s", c.body[0])
		}
	})
	t.Run("discord", func(t *testing.T) {
		c := &captured{}
		srv := c.server(t, 204)
		if err := webhook(t, "discord", "", map[string]string{"url": srv.URL}, nil).Send(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(c.body[0]), `"content":"Kubeast: 2 audit events`) {
			t.Fatalf("discord body %s", c.body[0])
		}
	})
	t.Run("telegram path and chat id", func(t *testing.T) {
		c := &captured{}
		srv := c.server(t, 200)
		s := webhook(t, "telegram", srv.URL, map[string]string{"botToken": "123:abc"}, func(sc *SinkConfig) { sc.Webhook.ChatID = "-1001" })
		if err := s.Send(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		if c.reqs[0].URL.Path != "/bot123:abc/sendMessage" || !strings.Contains(string(c.body[0]), `"chat_id":"-1001"`) {
			t.Fatalf("telegram %s %s", c.reqs[0].URL.Path, c.body[0])
		}
	})
	t.Run("pagerduty one trigger per event", func(t *testing.T) {
		c := &captured{}
		srv := c.server(t, 202)
		if err := webhook(t, "pagerduty", srv.URL, map[string]string{"routingKey": "R1"}, nil).Send(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		if len(c.body) != 2 {
			t.Fatalf("want 2 requests, got %d", len(c.body))
		}
		var pd struct {
			RoutingKey  string `json:"routing_key"`
			EventAction string `json:"event_action"`
			DedupKey    string `json:"dedup_key"`
			Payload     struct {
				Severity string `json:"severity"`
				Source   string `json:"source"`
			} `json:"payload"`
		}
		_ = json.Unmarshal(c.body[1], &pd)
		if pd.RoutingKey != "R1" || pd.EventAction != "trigger" || pd.DedupKey != "kubeast-audit-42" || pd.Payload.Severity != "error" || pd.Payload.Source != "kubeast" {
			t.Fatalf("pagerduty %s", c.body[1])
		}
	})
	t.Run("non-2xx is an error and keeps the token out", func(t *testing.T) {
		c := &captured{}
		srv := c.server(t, 500)
		err := webhook(t, "json", srv.URL, nil, nil).Send(context.Background(), ev)
		if err == nil || !strings.Contains(err.Error(), "HTTP 500") {
			t.Fatalf("want HTTP 500 error, got %v", err)
		}
		bad := webhook(t, "telegram", "http://127.0.0.1:1", map[string]string{"botToken": "999:secret"}, func(sc *SinkConfig) { sc.Webhook.ChatID = "1" })
		if err := bad.Send(context.Background(), ev); err == nil || strings.Contains(err.Error(), "999:secret") {
			t.Fatalf("token leaked or no error: %v", err)
		}
	})
	t.Run("config errors", func(t *testing.T) {
		for _, sc := range []SinkConfig{
			{Name: "a", Type: "webhook", Webhook: WebhookConfig{Format: "slack"}},
			{Name: "a", Type: "webhook", Webhook: WebhookConfig{Format: "telegram"}, secrets: map[string]string{"botToken": "x"}},
			{Name: "a", Type: "webhook", Webhook: WebhookConfig{Format: "pagerduty"}},
			{Name: "a", Type: "webhook", Webhook: WebhookConfig{Format: "irc", URL: "http://x"}},
		} {
			if _, err := sc.build(); err == nil {
				t.Errorf("%+v should be refused", sc.Webhook)
			}
		}
	})
}

func TestS3Sink(t *testing.T) {
	var gotPath, gotMD5 string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotMD5 = r.URL.Path, r.Header.Get("Content-MD5")
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	sc := SinkConfig{Name: "s3", Type: "s3", S3: S3Config{Bucket: "audit", Prefix: "/kubeast/", Endpoint: srv.URL, ForcePathStyle: true},
		secrets: map[string]string{"accessKeyId": "AK", "secretAccessKey": "SK"}}
	s, err := sc.build()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Send(context.Background(), sampleEvents()); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/audit/kubeast/2026/10/05/07/000000000041-000000000042.ndjson.gz" {
		t.Fatalf("key %s", gotPath)
	}
	sum := md5.Sum(gotBody)
	if gotMD5 != base64.StdEncoding.EncodeToString(sum[:]) {
		t.Fatalf("Content-MD5 %q does not match the body", gotMD5)
	}
	zr, err := gzip.NewReader(bytes.NewReader(gotBody))
	if err != nil {
		t.Fatal(err)
	}
	lines := 0
	sc2 := bufio.NewScanner(zr)
	for sc2.Scan() {
		var e Event
		if err := json.Unmarshal(sc2.Bytes(), &e); err != nil {
			t.Fatal(err)
		}
		lines++
	}
	if lines != 2 {
		t.Fatalf("want 2 NDJSON lines, got %d", lines)
	}
	for _, bad := range []SinkConfig{
		{Name: "x", Type: "s3"},
		{Name: "x", Type: "s3", S3: S3Config{Bucket: "b", SSE: "rot13"}},
		{Name: "x", Type: "s3", S3: S3Config{Bucket: "b"}, secrets: map[string]string{"accessKeyId": "only"}},
	} {
		if _, err := bad.build(); err == nil {
			t.Errorf("%+v should be refused", bad.S3)
		}
	}
}

func TestFileSinkRotates(t *testing.T) {
	dir := t.TempDir()
	s, err := (SinkConfig{Name: "f", Type: "file", File: FileConfig{Path: dir, MaxSizeMB: 1, MaxFiles: 2}}).build()
	if err != nil {
		t.Fatal(err)
	}
	fs := s.(*fileSink)
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fs.now = func() time.Time { clock = clock.Add(time.Second); return clock }
	big := sampleEvents()
	big[0].Error = strings.Repeat("x", 600<<10) // ~600 KiB per write
	for i := 0; i < 6; i++ {
		if err := s.Send(context.Background(), big[:1]); err != nil {
			t.Fatal(err)
		}
	}
	rotated, _ := filepath.Glob(filepath.Join(dir, "audit-*.ndjson"))
	if len(rotated) != 2 {
		t.Fatalf("want 2 rotated files kept, got %d", len(rotated))
	}
	if _, err := os.Stat(filepath.Join(dir, "audit.ndjson")); err != nil {
		t.Fatal(err)
	}
}

// fakeSMTP accepts one message and returns it.
func fakeSMTP(t *testing.T) (addr string, got chan string) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got = make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		r := bufio.NewReader(conn)
		w := func(s string) { conn.Write([]byte(s + "\r\n")) }
		w("220 fake")
		var data strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			if inData {
				if line == ".\r\n" {
					inData = false
					got <- data.String()
					w("250 queued")
					continue
				}
				data.WriteString(line)
				continue
			}
			switch cmd := strings.ToUpper(strings.TrimSpace(line)); {
			case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
				w("250 fake")
			case cmd == "DATA":
				inData = true
				w("354 go")
			case cmd == "QUIT":
				w("221 bye")
				return
			default:
				w("250 ok")
			}
		}
	}()
	return ln.Addr().String(), got
}

func TestEmailSink(t *testing.T) {
	addr, got := fakeSMTP(t)
	host, port, _ := net.SplitHostPort(addr)
	var p int
	for _, ch := range port {
		p = p*10 + int(ch-'0')
	}
	s, err := (SinkConfig{Name: "m", Type: "email", Email: EmailConfig{Host: host, Port: p, TLS: "none", From: "kubeast@example.com", To: []string{"sre@example.com"}}}).build()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Send(context.Background(), sampleEvents()); err != nil {
		t.Fatal(err)
	}
	msg := <-got
	for _, want := range []string{"From: kubeast@example.com", "To: sre@example.com", "Subject: ", "- k8s.pod.delete success", `"id":42`} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message lacks %q:\n%s", want, msg)
		}
	}
	if _, err := (SinkConfig{Name: "m", Type: "email", Email: EmailConfig{Host: "h", From: "f", To: []string{"t"}, TLS: "none"}, secrets: map[string]string{"username": "u"}}).build(); err == nil {
		t.Fatal("login without TLS must be refused")
	}
}

func TestLoadFile(t *testing.T) {
	dir := t.TempDir()
	secrets := filepath.Join(dir, "secrets")
	os.MkdirAll(filepath.Join(secrets, "slack"), 0o755)
	os.WriteFile(filepath.Join(secrets, "slack", "url"), []byte("https://hooks.example/abc\n"), 0o600)
	file := filepath.Join(dir, "sinks.yaml")
	os.WriteFile(file, []byte(`sinks:
  - name: slack
    type: webhook
    webhook: {format: slack}
    filter: {actions: ["k8s.*.delete"]}
  - name: archive
    type: file
    file: {path: `+dir+`}
`), 0o600)
	cfg, err := LoadFile(file, secrets)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Sinks) != 2 || cfg.Sinks[0].secret("url") != "https://hooks.example/abc" {
		t.Fatalf("loaded %+v", cfg.Sinks)
	}
	if cfg.Sinks[0].startAtBeginning() || !cfg.Sinks[1].startAtBeginning() {
		t.Fatal("notification sinks start at the latest row, archives at the beginning")
	}
	if n, w := cfg.Sinks[0].batchLimits(); n != 20 || w != 5 {
		t.Fatalf("webhook defaults %d/%d", n, w)
	}
	if empty, err := LoadFile("", secrets); err != nil || len(empty.Sinks) != 0 {
		t.Fatal("no file means no sinks")
	}
	for _, bad := range []string{
		"sinks: [{name: Bad_Name, type: file, file: {path: /tmp}}]",
		"sinks: [{name: a, type: file, file: {path: /tmp}}, {name: a, type: file, file: {path: /tmp}}]",
		"sinks: [{name: a, type: ftp}]",
		"sinks: [{name: a, type: file, startFrom: middle, file: {path: /tmp}}]",
	} {
		os.WriteFile(file, []byte(bad), 0o600)
		if _, err := LoadFile(file, secrets); err == nil {
			t.Errorf("should be refused: %s", bad)
		}
	}
}
