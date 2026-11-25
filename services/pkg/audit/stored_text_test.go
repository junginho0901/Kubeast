package audit

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

// recordOver sends raw, a whole HTTP request, to a server and answers the record its handler made of it, as the services'
// handlers do, or false when the server refused the request itself (a header holding 0x00).
func recordOver(t *testing.T, raw string) (Record, bool) {
	t.Helper()
	got := make(chan Record, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := FromHTTPRequest(r)
		rec.Action = "k8s.pod.delete"
		rec.TargetType, rec.TargetID = "pod", r.URL.Query().Get("name")
		rec.Cluster, rec.Namespace = r.URL.Query().Get("cluster"), r.URL.Query().Get("namespace")
		got <- rec
	}))
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == http.StatusBadRequest {
		return Record{}, false
	}
	return <-got, true
}

// A row is stored whatever a request holds: each part of it that reaches a row, with each kind of text PostgreSQL refuses.
func TestARowIsStoredWhateverTheRequestHolds(t *testing.T) {
	texts := map[string]string{
		"a byte that is not UTF-8": "\xff",
		"0x00":                     "\x00",
		"a long text":              strings.Repeat("x", 4000),
		"an empty value":           "",
	}
	percent := func(s string) string {
		var out strings.Builder
		for i := 0; i < len(s); i++ {
			fmt.Fprintf(&out, "%%%02X", s[i])
		}
		return out.String()
	}
	parts := map[string]func(text string) (path, header string){
		"user_agent": func(s string) (string, string) { return "/", "User-Agent: a" + s + "b" },
		"request_id": func(s string) (string, string) { return "/", "X-Request-ID: a" + s + "b" },
		"request_ip": func(s string) (string, string) { return "/", "X-Real-IP: a" + s + "b" },
		"path":       func(s string) (string, string) { return "/a" + percent(s) + "b", "X-Other: 1" },
		"target_id":  func(s string) (string, string) { return "/?name=a" + percent(s) + "b", "X-Other: 1" },
		"cluster":    func(s string) (string, string) { return "/?cluster=a" + percent(s) + "b", "X-Other: 1" },
		"namespace":  func(s string) (string, string) { return "/?namespace=a" + percent(s) + "b", "X-Other: 1" },
	}
	for column, part := range parts {
		for name, text := range texts {
			t.Run(column+"/"+name, func(t *testing.T) {
				path, header := part(text)
				rec, ok := recordOver(t, "GET "+path+" HTTP/1.1\r\nHost: x\r\n"+header+"\r\nConnection: close\r\n\r\n")
				if !ok && strings.Contains(header, "\x00") {
					return
				}
				pg, pool := startFakePG(t)
				if _, err := NewPostgresStore(pool, ServiceK8s).Write(context.Background(), rec); err != nil {
					t.Fatalf("not stored: %v", err)
				}
				row := pg.last(t)
				if row["action"] != "k8s.pod.delete" || !strings.HasPrefix(strings.TrimPrefix(row[column], "/"), "a") {
					t.Errorf("row = %q", row)
				}
			})
		}
	}
}

// The payload and the error are text a caller sent too: a name in a body, a message that quotes it.
func TestARowIsStoredWhateverItsPayloadHolds(t *testing.T) {
	pg, pool := startFakePG(t)
	store := NewPostgresStore(pool, ServiceAuth)
	for name, rec := range map[string]Record{
		"a body's 0x00":                   {After: MustJSON(map[string]any{"name": "a\x00b"})},
		"a body's 0x00, masked":           {After: MaskSensitive(MustJSON(map[string]any{"name": "a\x00b", "token": "x"}))},
		"a body's 0x00 in a key":          {After: MustJSON(map[string]any{"a\x00b": 1})},
		"a lone half in a payload":        {After: json.RawMessage(`{"name":"\ud800"}`)},
		"a lone half in a before":         {Before: json.RawMessage(`{"name":"\udc00x"}`)},
		"bytes that are not UTF-8":        {After: json.RawMessage("{\"name\":\"a\xffb\"}")},
		"a payload that is not JSON":      {After: json.RawMessage("name: a")},
		"a payload cut short":             {Before: json.RawMessage(`{"name":"a`)},
		"an error quoting a bad byte":     {Result: ResultFailure, Error: "name \xff is not valid"},
		"an error quoting 0x00":           {Result: ResultFailure, Error: "name \x00 is not valid"},
		"a user's id and email":           {TargetType: "user", TargetID: "u\xff", TargetEmail: "a\x00@example.com"},
		"an actor":                        {ActorUserID: "u\xff", ActorEmail: "a\xff@example.com"},
		"an actor's id past the index":    {ActorUserID: strings.Repeat("u", 9000)},
		"a target past the index":         {TargetType: "cluster", TargetID: strings.Repeat("c", 9000), Cluster: strings.Repeat("c", 9000)},
		"a target past the index, 가":      {TargetType: "cluster", TargetID: strings.Repeat("가", 3000)},
		"a service and an action":         {Service: "\xff", Action: "a\x00"},
		"a target type and a result":      {TargetType: "\xff", Result: "\xff"},
		"no text at all":                  {},
		"a payload of an empty object":    {Before: json.RawMessage("{}"), After: json.RawMessage("{}")},
		"a payload that is JSON's null":   {After: json.RawMessage("null")},
		"a payload with a pair of halves": {After: json.RawMessage(`{"name":"\ud83d\ude00"}`)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := store.Write(context.Background(), rec); err != nil {
				t.Fatalf("not stored: %v", err)
			}
			for column, value := range pg.last(t) {
				if !utf8.ValidString(value) {
					t.Errorf("%s = %q", column, value)
				}
			}
		})
	}
}
