package main

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// pgRule answers the statements containing match. A nil cell is NULL.
type pgRule struct {
	match string
	oids  []uint32
	rows  [][]any
}

// fakePG speaks enough of the PostgreSQL protocol for the real repository, so a
// test can walk a request through the real routes and handlers without a
// server. A statement no rule matches gets an empty result.
type fakePG struct {
	rules   []pgRule
	mu      sync.Mutex
	seen    []string
	failing []string
	codes   map[string]string // failing text → SQLSTATE, XX000 when not set
}

func startFakePG(t *testing.T, rules ...pgRule) (*fakePG, *pgxpool.Pool) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	f := &fakePG{rules: rules}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	cfg, err := pgxpool.ParseConfig(fmt.Sprintf("postgres://test@%s/test?sslmode=disable&default_query_exec_mode=simple_protocol", ln.Addr()))
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return f, pool
}

func (f *fakePG) serve(c net.Conn) {
	defer c.Close()
	be := pgproto3.NewBackend(c, c)
	if _, err := be.ReceiveStartupMessage(); err != nil {
		return
	}
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
			f.answer(be, m.String)
			if err := be.Flush(); err != nil {
				return
			}
		case *pgproto3.Terminate:
			return
		}
	}
}

func (f *fakePG) answer(be *pgproto3.Backend, sql string) {
	f.mu.Lock()
	f.seen = append(f.seen, sql)
	failing := f.failing
	codes := f.codes
	f.mu.Unlock()
	for _, text := range failing {
		if strings.Contains(sql, text) {
			code := codes[text]
			if code == "" {
				code = "XX000"
			}
			be.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: code, Message: "fake database failure"})
			be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
			return
		}
	}
	n := 0
	for _, rule := range f.rules {
		if !strings.Contains(sql, rule.match) {
			continue
		}
		fields := make([]pgproto3.FieldDescription, len(rule.oids))
		for i, oid := range rule.oids {
			fields[i] = pgproto3.FieldDescription{Name: []byte(fmt.Sprintf("c%d", i)), DataTypeOID: oid, DataTypeSize: -1, TypeModifier: -1}
		}
		be.Send(&pgproto3.RowDescription{Fields: fields})
		for _, row := range rule.rows {
			values := make([][]byte, len(row))
			for i, cell := range row {
				if cell != nil {
					values[i] = []byte(fmt.Sprint(cell))
				}
			}
			be.Send(&pgproto3.DataRow{Values: values})
			n++
		}
		break
	}
	be.Send(&pgproto3.CommandComplete{CommandTag: commandTag(sql, n)})
	be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
}

// commandTag says one row changed for a write, the way pgx counts them.
func commandTag(sql string, rows int) []byte {
	verb := strings.ToUpper(strings.Fields(sql)[0])
	switch verb {
	case "INSERT":
		return []byte("INSERT 0 1")
	case "UPDATE", "DELETE":
		return []byte(verb + " 1")
	case "SELECT":
		return []byte(fmt.Sprintf("SELECT %d", rows))
	}
	return []byte(verb)
}

// sessionState answers auth.SessionStateQuery: the user's token_version and the auth_time of each signed-out sign-in.
func sessionState(version int, signedOut ...int64) pgRule {
	list := make([]string, len(signedOut))
	for i, at := range signedOut {
		list[i] = strconv.FormatInt(at, 10)
	}
	return pgRule{match: "SELECT token_version, ARRAY(", oids: []uint32{uint32(pgtype.Int4OID), uint32(pgtype.Int8ArrayOID)},
		rows: [][]any{{version, "{" + strings.Join(list, ",") + "}"}}}
}

// statement returns the first statement containing text that reached the database, "" when none did.
func (f *fakePG) statement(text string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, sql := range f.seen {
		if strings.Contains(sql, text) {
			return sql
		}
	}
	return ""
}

// ran reports whether a statement containing text reached the database.
func (f *fakePG) ran(text string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, sql := range f.seen {
		if strings.Contains(sql, text) {
			return true
		}
	}
	return false
}

// failOn makes every statement containing text fail, as a database that went away would.
func (f *fakePG) failOn(text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failing = append(f.failing, text)
}

// failOnCode is failOn with the SQLSTATE a real database would give.
func (f *fakePG) failOnCode(text, code string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failing = append(f.failing, text)
	if f.codes == nil {
		f.codes = map[string]string{}
	}
	f.codes[text] = code
}

func (f *fakePG) forget() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seen = nil
}
