package clustersync

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

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/cache"
	"github.com/junginho0901/kubeast/services/pkg/cluster"
	"github.com/junginho0901/kubeast/services/pkg/clusternotice"
	"github.com/junginho0901/kubeast/services/pkg/redisacl"
)

// chartHelpers holds the chart's Redis users (kubeast.redisUsersAcl).
const chartHelpers = "../../../../helm/kubeast/templates/_helpers.tpl"

// noticeRecorder is a Redis stand-in for the notices: it refuses HELLO, as a server without RESP3 does, so the client
// signs in with AUTH, and after SUBSCRIBE it sends the messages it was given on that channel. It records every
// command, the arguments of each AUTH and the channel each SUBSCRIBE and PUBLISH names.
type noticeRecorder struct {
	ln       net.Listener
	messages []string

	mu       sync.Mutex
	commands []string
	auths    []string
	channels map[string][]string
}

func newNoticeRecorder(t *testing.T, messages []string) *noticeRecorder {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &noticeRecorder{ln: ln, messages: messages, channels: map[string][]string{}}
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

func (s *noticeRecorder) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	subscribed := false
	for {
		args, err := readCommand(r)
		if err != nil {
			return
		}
		name := strings.ToUpper(args[0])
		s.mu.Lock()
		s.commands = append(s.commands, name)
		switch {
		case name == "AUTH":
			s.auths = append(s.auths, strings.Join(args[1:], " "))
		case (name == "SUBSCRIBE" || name == "PUBLISH") && len(args) > 1:
			s.channels[name] = append(s.channels[name], args[1])
		}
		s.mu.Unlock()
		reply := "+OK\r\n"
		switch name {
		case "HELLO":
			reply = "-ERR unknown command 'HELLO'\r\n"
		case "PING":
			reply = "+PONG\r\n"
			if subscribed {
				reply = "*2\r\n" + bulk("pong") + bulk("")
			}
		case "PUBLISH":
			reply = ":0\r\n"
		case "SUBSCRIBE":
			subscribed = true
			reply = "*3\r\n" + bulk("subscribe") + bulk(args[1]) + ":1\r\n"
			for _, m := range s.messages {
				reply += "*3\r\n" + bulk("message") + bulk(args[1]) + bulk(m)
			}
		case "UNSUBSCRIBE":
			ch := ""
			if len(args) > 1 {
				ch = args[1]
			}
			reply = "*3\r\n" + bulk("unsubscribe") + bulk(ch) + ":0\r\n"
		}
		if _, err := io.WriteString(conn, reply); err != nil {
			return
		}
	}
}

func (s *noticeRecorder) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

func bulk(s string) string { return "$" + strconv.Itoa(len(s)) + "\r\n" + s + "\r\n" }

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

// What clustersync sends to Redis, the notices it listens to and publishes, is what the chart's Redis user
// k8s-service may run: in an install with redis.acl Redis refuses any other with NOPERM, and a replica would neither
// tell the others of a change nor hear of theirs (only the versions would reach them). The client is built as
// cmd/server's clusterNotices builds it (cache.Options on database 3, the user and its password); a notice comes from
// another replica, and one goes out.
func TestTheNoticesRedisCommandsAreThoseItsChartUserMayRun(t *testing.T) {
	channel := clusternotice.ChannelFor(3)
	s := newNoticeRecorder(t, []string{`{"cluster":"prod","from":"another-replica"}`})
	rdb := redis.NewClient(cache.Options("127.0.0.1", s.port(), 3, "k8s-service", "pw-k8s"))
	t.Cleanup(func() { _ = rdb.Close() })
	r := &replica{Sync: New(&registry{versions: map[cluster.ID]int64{"prod": 1}}, rdb), kept: map[cluster.ID]int64{"prod": 1}}
	r.Every = time.Hour // no timed read
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx, r); close(done) }()
	eventually(t, func() bool { return equal(r.noticeDrops(), []cluster.ID{"prod"}) })
	r.Changed("stage")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context ended")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.auths) == 0 || s.auths[0] != "k8s-service pw-k8s" {
		t.Fatalf("AUTH %q, want AUTH k8s-service <password>", s.auths)
	}
	for _, cmd := range []string{"SUBSCRIBE", "PUBLISH"} {
		if got := s.channels[cmd]; len(got) != 1 || got[0] != channel {
			t.Fatalf("%s on %q, want once on %s", cmd, got, channel)
		}
	}
	allowed, err := redisacl.Commands(chartHelpers, "k8s-service")
	if err != nil {
		t.Fatal(err)
	}
	if refused := redisacl.Refused(s.commands, allowed); len(refused) > 0 {
		t.Fatalf("clustersync sends %s, which the chart's Redis user k8s-service does not allow: add it to that user's line in helm/kubeast/templates/_helpers.tpl (kubeast.redisUsersAcl) with a case in tests/redis_test.yaml, or send a command the line allows (sent: %v)",
			strings.Join(refused, ", "), s.commands)
	}
}
