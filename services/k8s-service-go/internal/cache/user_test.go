package cache

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// signInRecorder is a Redis stand-in that refuses HELLO, as a server without RESP3 does, so the client signs in with
// AUTH, and records the arguments of each AUTH it is sent.
type signInRecorder struct {
	ln    net.Listener
	mu    sync.Mutex
	auths [][]string
}

func newSignInRecorder(t *testing.T) *signInRecorder {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &signInRecorder{ln: ln}
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

func (s *signInRecorder) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		args, err := readCommand(r)
		if err != nil {
			return
		}
		reply := "-ERR unknown command\r\n"
		switch strings.ToUpper(args[0]) {
		case "AUTH":
			s.mu.Lock()
			s.auths = append(s.auths, args[1:])
			s.mu.Unlock()
			reply = "+OK\r\n"
		case "PING":
			reply = "+PONG\r\n"
		}
		if _, err := conn.Write([]byte(reply)); err != nil {
			return
		}
	}
}

// readCommand reads one RESP array of bulk strings, the form a client sends a command in.
func readCommand(r *bufio.Reader) ([]string, error) {
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

func (s *signInRecorder) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func (s *signInRecorder) signIns() [][]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([][]string(nil), s.auths...)
}

// The chart's redis.acl gives k8s-service the Redis user k8s-service (REDIS_USERNAME): the cache signs in as that user.
// Without a username — an older install, a Redis without ACL users — it signs in with the password alone, as before.
func TestNewWithUserSignsInAsTheUserAndWithoutOneAsBefore(t *testing.T) {
	cases := []struct {
		username string
		want     []string
	}{
		{username: "k8s-service", want: []string{"k8s-service", "pw-k8s"}},
		{username: "", want: []string{"pw-k8s"}},
	}
	for _, tc := range cases {
		s := newSignInRecorder(t)
		c := NewWithUser("127.0.0.1", s.port(), 0, tc.username, "pw-k8s")
		if !c.IsConnected() {
			t.Fatalf("username %q: not connected to the stand-in", tc.username)
		}
		got := s.signIns()
		if len(got) == 0 {
			t.Fatalf("username %q: no AUTH sent", tc.username)
		}
		if strings.Join(got[0], " ") != strings.Join(tc.want, " ") {
			t.Fatalf("username %q: AUTH %q, want AUTH %q", tc.username, got[0], tc.want)
		}
		_ = c.rdb.Load().Close()
	}
}
