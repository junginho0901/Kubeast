// Package dbsessiontest is a stand-in PostgreSQL server for tests of what a client sends when it connects: it takes
// any connection without TLS or a password, keeps each startup message's parameters and every simple query, and
// answers each query with an empty result (or an error for the text given to Fail).
package dbsessiontest

import (
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgproto3"
)

// Server is one stand-in server on a loopback port.
type Server struct {
	addr string

	mu       sync.Mutex
	startups []map[string]string
	queries  []string
	failing  []string
}

// Start listens on a loopback port until the test ends.
func Start(t testing.TB) *Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	s := &Server{addr: ln.Addr().String()}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(c)
		}
	}()
	return s
}

// URL is a connection string for the server.
func (s *Server) URL() string {
	return fmt.Sprintf("postgres://test@%s/test?sslmode=disable", s.addr)
}

// Startups is the parameters of each startup message, in the order the connections came.
func (s *Server) Startups() []map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]map[string]string, len(s.startups))
	copy(out, s.startups)
	return out
}

// Queries is every simple query, in the order they came.
func (s *Server) Queries() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.queries...)
}

// Fail makes every later query containing text answer an error.
func (s *Server) Fail(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failing = append(s.failing, text)
}

func (s *Server) serve(c net.Conn) {
	defer c.Close()
	be := pgproto3.NewBackend(c, c)
	msg, err := be.ReceiveStartupMessage()
	if err != nil {
		return
	}
	startup, ok := msg.(*pgproto3.StartupMessage)
	if !ok {
		return
	}
	params := map[string]string{}
	for k, v := range startup.Parameters {
		params[k] = v
	}
	s.mu.Lock()
	s.startups = append(s.startups, params)
	s.mu.Unlock()
	be.Send(&pgproto3.AuthenticationOk{})
	be.Send(&pgproto3.ParameterStatus{Name: "client_encoding", Value: "UTF8"})
	be.Send(&pgproto3.ParameterStatus{Name: "standard_conforming_strings", Value: "on"})
	be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if err := be.Flush(); err != nil {
		return
	}
	for {
		msg, err := be.Receive()
		if err != nil {
			return
		}
		switch m := msg.(type) {
		case *pgproto3.Query:
			s.answer(be, m.String)
			if err := be.Flush(); err != nil {
				return
			}
		case *pgproto3.Terminate:
			return
		}
	}
}

func (s *Server) answer(be *pgproto3.Backend, sql string) {
	s.mu.Lock()
	s.queries = append(s.queries, sql)
	failing := append([]string(nil), s.failing...)
	s.mu.Unlock()
	for _, text := range failing {
		if strings.Contains(sql, text) {
			be.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: "XX000", Message: "stand-in failure"})
			be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
			return
		}
	}
	tag := "SELECT 0"
	if f := strings.Fields(sql); len(f) > 0 && !strings.HasPrefix(f[0], "--") {
		tag = strings.ToUpper(f[0])
	}
	be.Send(&pgproto3.CommandComplete{CommandTag: []byte(tag)})
	be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
}
