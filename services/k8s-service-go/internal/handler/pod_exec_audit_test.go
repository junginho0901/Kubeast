package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// The row says what was asked with its credentials masked, as an AI exec's does; the container gets the command as it
// was asked.
func TestAnExecRowHoldsTheCommandWithoutItsCredentials(t *testing.T) {
	for _, c := range []struct{ name, command, row string }{
		{"a credential's flag", "mysql -h db --password=fake-pass-1", "mysql -h db --password=<REDACTED:password>"},
		{"a variable in front of a program", "env API_TOKEN=fake-token-1 app", "env API_TOKEN=<REDACTED:API_TOKEN> app"},
		{"mysql's joined -p", "mysql -h db -pfake-pass-1", "mysql -h db -p<REDACTED:password>"},
		{"a shell", "/bin/sh", "/bin/sh"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var version atomic.Int32
			h, store := liveHandler(t, func(http.ResponseWriter, *http.Request) {}, &version)
			fake := &fakeExecutor{endOnEOT: true}
			var sent atomic.Pointer[url.URL]
			orig := newShellExecutor
			newShellExecutor = func(_ *rest.Config, u *url.URL) (remotecommand.Executor, error) {
				sent.Store(u)
				return fake, nil
			}
			t.Cleanup(func() { newShellExecutor = orig })
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				h.PodExecWS(w, withLogFileContext(r, "apps", "resource.pod.exec"))
			}))
			defer srv.Close()
			target := "ws" + strings.TrimPrefix(srv.URL, "http") + "?container=app&command=" + url.QueryEscape(c.command)
			conn, _, err := websocket.DefaultDialer.Dial(target, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			readFrame(t, conn) // ready
			readFrame(t, conn) // prompt

			if got := sent.Load(); got == nil || got.Query().Get("command") != c.command {
				t.Errorf("the container was asked to run %v, want %q", got, c.command)
			}

			var after map[string]any
			store.mu.Lock()
			for _, row := range store.rows {
				if row.Action == "k8s.pod.exec" {
					if err := json.Unmarshal(row.After, &after); err != nil {
						t.Error(err)
					}
					break
				}
			}
			store.mu.Unlock()
			if after["command"] != c.row || after["container"] != "app" {
				t.Errorf("the row holds %v, want command %q", after, c.row)
			}

			version.Store(1)
			readFrame(t, conn) // the notice
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			_, _, err = conn.ReadMessage()
			var closed *websocket.CloseError
			if !errors.As(err, &closed) {
				t.Fatalf("after the notice: %v", err)
			}
		})
	}
}
