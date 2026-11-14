package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/junginho0901/kubeast/services/pkg/redisacl"
)

// noticeServer is a Redis stand-in for one subscriber: it refuses HELLO, as a server without RESP3 does, so the client
// signs in with AUTH; after SUBSCRIBE it sends the messages it was given on that channel. It records every command.
type noticeServer struct {
	ln       net.Listener
	messages []string

	mu         sync.Mutex
	commands   []string
	auths      [][]string
	subscribed []string
}

func newNoticeServer(t *testing.T, messages []string) *noticeServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &noticeServer{ln: ln, messages: messages}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(conn)
		}
	}()
	return s
}

func (s *noticeServer) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	subscribed := false
	for {
		args, err := readRESPCommand(r)
		if err != nil {
			return
		}
		name := strings.ToUpper(args[0])
		s.mu.Lock()
		s.commands = append(s.commands, name)
		s.mu.Unlock()
		var reply string
		switch name {
		case "AUTH":
			s.mu.Lock()
			s.auths = append(s.auths, args[1:])
			s.mu.Unlock()
			reply = "+OK\r\n"
		case "SELECT":
			reply = "+OK\r\n"
		case "PING":
			reply = "+PONG\r\n"
			if subscribed {
				reply = "*2\r\n" + bulk("pong") + bulk("")
			}
		case "SUBSCRIBE":
			subscribed = true
			ch := args[1]
			s.mu.Lock()
			s.subscribed = append(s.subscribed, ch)
			s.mu.Unlock()
			reply = "*3\r\n" + bulk("subscribe") + bulk(ch) + ":1\r\n"
			for _, m := range s.messages {
				reply += "*3\r\n" + bulk("message") + bulk(ch) + bulk(m)
			}
		case "UNSUBSCRIBE":
			ch := ""
			if len(args) > 1 {
				ch = args[1]
			}
			reply = "*3\r\n" + bulk("unsubscribe") + bulk(ch) + ":0\r\n"
		default:
			reply = "-ERR unknown command '" + args[0] + "'\r\n"
		}
		if _, err := io.WriteString(conn, reply); err != nil {
			return
		}
	}
}

func bulk(s string) string { return "$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n" }

// readRESPCommand reads one RESP array of bulk strings, the form a client sends a command in.
func readRESPCommand(r *bufio.Reader) ([]string, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "*")))
	if err != nil || n < 1 {
		return nil, fmt.Errorf("not a command: %q", line)
	}
	args := make([]string, 0, n)
	for i := 0; i < n; i++ {
		head, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		size, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(head, "$")))
		if err != nil {
			return nil, err
		}
		buf := make([]byte, size+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		args = append(args, string(buf[:size]))
	}
	return args, nil
}

// A notice drops its cluster; a message that is not a notice drops nothing. tool-server signs in as its Redis user,
// subscribes to the notice channel of its database and sends no command that reads, writes or publishes.
func TestClusterNoticesDropTheirClusterAndSendNothingElse(t *testing.T) {
	notice := func(id string) string { return `{"cluster":"` + id + `","from":"0123456789abcdef"}` }
	s := newNoticeServer(t, []string{
		notice("prod"),
		"not a notice",
		`{"cluster":"x","from":"` + strings.Repeat("a", 2048) + `"}`,
		`{"cluster":"","from":"x"}`,
		notice("stage"),
	})
	rdb := redis.NewClient(&redis.Options{Addr: s.ln.Addr().String(), Username: "tool-server", Password: "pw-tool-server"})
	defer rdb.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dropped := make(chan string, 8)
	done := make(chan struct{})
	go func() {
		defer close(done)
		listenClusterNotices(ctx, rdb, func(id string) { dropped <- id })
	}()

	for _, want := range []string{"prod", "stage"} {
		select {
		case got := <-dropped:
			if got != want {
				t.Fatalf("dropped %q, want %q", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no drop of %q within 5 s", want)
		}
	}
	select {
	case extra := <-dropped:
		t.Fatalf("dropped %q from a message that is not a notice", extra)
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("listenClusterNotices did not return after its context ended")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.auths) == 0 || strings.Join(s.auths[0], " ") != "tool-server pw-tool-server" {
		t.Fatalf("AUTH %q, want AUTH tool-server <password>", s.auths)
	}
	if len(s.subscribed) != 1 || s.subscribed[0] != "kubeast:clusters:changed:0" {
		t.Fatalf("subscribed to %q, want kubeast:clusters:changed:0", s.subscribed)
	}
	// What it sends is held to the chart's Redis user tool-server, which Redis would otherwise refuse with NOPERM.
	allowed, err := redisacl.Commands("../../helm/kubeast/templates/_helpers.tpl", "tool-server")
	if err != nil {
		t.Fatal(err)
	}
	if refused := redisacl.Refused(s.commands, allowed); len(refused) > 0 {
		t.Errorf("sent %s, which the chart's Redis user tool-server does not allow (kubeast.redisUsersAcl in helm/kubeast/templates/_helpers.tpl; sent: %v)", strings.Join(refused, ", "), s.commands)
	}
}

// The connection comes from the environment the chart gives tool-server; no REDIS_HOST, no listening.
func TestClusterNoticeClientReadsTheEnvironment(t *testing.T) {
	t.Setenv("REDIS_HOST", "")
	if rdb := clusterNoticeClient(); rdb != nil {
		_ = rdb.Close()
		t.Fatal("a client without REDIS_HOST")
	}
	t.Setenv("REDIS_HOST", "redis")
	t.Setenv("REDIS_PORT", "6380")
	t.Setenv("REDIS_DB", "7")
	t.Setenv("REDIS_USERNAME", "tool-server")
	t.Setenv("REDIS_PASSWORD", "pw-tool-server")
	rdb := clusterNoticeClient()
	if rdb == nil {
		t.Fatal("no client with REDIS_HOST")
	}
	defer rdb.Close()
	o := rdb.Options()
	if o.Addr != "redis:6380" || o.DB != 7 || o.Username != "tool-server" || o.Password != "pw-tool-server" {
		t.Fatalf("options addr=%s db=%d user=%s password set=%v", o.Addr, o.DB, o.Username, o.Password != "")
	}
	t.Setenv("REDIS_DB", "seven")
	if rdb := clusterNoticeClient(); rdb != nil {
		_ = rdb.Close()
		t.Fatal("a client with REDIS_DB not a number")
	}
}
