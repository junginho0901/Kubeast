package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fakePG speaks enough of the PostgreSQL protocol for PostgresStore, and refuses a row for what it holds as PostgreSQL
// does: bytes that are not UTF-8, 0x00, JSON a JSONB column does not take, text too long for an index entry.
type fakePG struct {
	mu      sync.Mutex
	rows    []map[string]string // the stored rows, NULL columns absent
	probes  int
	refuse  string // an SQLSTATE every row is refused with
	refused []string
}

// auditColumns are the columns PostgresStore.Write inserts, in its order.
var auditColumns = []string{"service", "action", "actor_user_id", "actor_email", "target_user_id", "target_email", "target_type",
	"target_id", "before", "after", "request_ip", "user_agent", "request_id", "path", "cluster", "namespace", "result", "error"}

func startFakePG(t *testing.T) (*fakePG, *pgxpool.Pool) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	f := &fakePG{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	pool, err := pgxpool.New(context.Background(), fmt.Sprintf("postgres://test@%s/test?sslmode=disable", ln.Addr()))
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
	status := byte('I')
	be.Send(&pgproto3.ReadyForQuery{TxStatus: status})
	if be.Flush() != nil {
		return
	}
	statements := map[string]string{}
	var bound pgproto3.Bind
	skip := false // after an error, until Sync
	fail := func(code, message string) {
		be.Send(&pgproto3.ErrorResponse{Severity: "ERROR", Code: code, Message: message})
		skip = true
		if status == 'T' {
			status = 'E'
		}
	}
	for {
		msg, err := be.Receive()
		if err != nil {
			return
		}
		switch m := msg.(type) {
		case *pgproto3.Query:
			switch {
			case strings.HasPrefix(m.String, "begin"):
				status = 'T'
			case strings.HasPrefix(m.String, "rollback"), strings.HasPrefix(m.String, "commit"):
				status = 'I'
			}
			be.Send(&pgproto3.CommandComplete{CommandTag: []byte(strings.ToUpper(strings.Fields(m.String + " ;")[0]))})
			be.Send(&pgproto3.ReadyForQuery{TxStatus: status})
		case *pgproto3.Parse:
			if !skip {
				statements[m.Name] = m.Query
				be.Send(&pgproto3.ParseComplete{})
			}
		case *pgproto3.Describe:
			if skip {
				break
			}
			if m.ObjectType == 'P' {
				be.Send(describeRow(statements[bound.PreparedStatement]))
				break
			}
			be.Send(&pgproto3.ParameterDescription{ParameterOIDs: parameterOIDs(statements[m.Name])})
			be.Send(describeRow(statements[m.Name]))
		case *pgproto3.Bind:
			if skip {
				break
			}
			bound = pgproto3.Bind{PreparedStatement: m.PreparedStatement, ResultFormatCodes: append([]int16(nil), m.ResultFormatCodes...)}
			for _, p := range m.Parameters {
				if p != nil {
					p = append([]byte{}, p...)
				}
				bound.Parameters = append(bound.Parameters, p)
			}
			be.Send(&pgproto3.BindComplete{})
		case *pgproto3.Execute:
			if skip {
				break
			}
			id, code, message := f.insert(statements[bound.PreparedStatement], bound.Parameters)
			if code != "" {
				fail(code, message)
				break
			}
			if id > 0 {
				be.Send(&pgproto3.DataRow{Values: [][]byte{{0, 0, 0, byte(id)}}}) // pgx asks for an int4 in binary
			}
			be.Send(&pgproto3.CommandComplete{CommandTag: []byte("INSERT 0 1")})
		case *pgproto3.Close:
			if !skip {
				be.Send(&pgproto3.CloseComplete{})
			}
		case *pgproto3.Sync:
			skip = false
			be.Send(&pgproto3.ReadyForQuery{TxStatus: status})
		case *pgproto3.Terminate:
			return
		}
		if be.Flush() != nil {
			return
		}
	}
}

func describeRow(sql string) pgproto3.BackendMessage {
	if !strings.Contains(sql, "RETURNING id") {
		return &pgproto3.NoData{}
	}
	return &pgproto3.RowDescription{Fields: []pgproto3.FieldDescription{{Name: []byte("id"), DataTypeOID: pgtype.Int4OID, DataTypeSize: 4, TypeModifier: -1}}}
}

func parameterOIDs(sql string) []uint32 {
	if !strings.Contains(sql, "RETURNING id") {
		return []uint32{pgtype.VarcharOID}
	}
	oids := make([]uint32, len(auditColumns))
	for i, name := range auditColumns {
		switch name {
		case "before", "after":
			oids[i] = pgtype.JSONBOID
		case "error":
			oids[i] = pgtype.TextOID
		default:
			oids[i] = pgtype.VarcharOID
		}
	}
	return oids
}

// insert answers the id of the row stored, 0 for a probe, or the SQLSTATE it is refused with.
func (f *fakePG) insert(sql string, params [][]byte) (int, string, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refuse != "" {
		return 0, f.refuse, "fake refusal of every row"
	}
	if !strings.Contains(sql, "RETURNING id") {
		f.probes++
		return 0, "", ""
	}
	row := map[string]string{}
	for i, name := range auditColumns {
		if params[i] == nil {
			continue
		}
		if code := refusalOf(name, params[i]); code != "" {
			f.refused = append(f.refused, name)
			return 0, code, "fake refusal of " + name
		}
		row[name] = string(params[i])
	}
	f.rows = append(f.rows, row)
	return len(f.rows), "", ""
}

func (f *fakePG) last(t *testing.T) map[string]string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.rows) == 0 {
		t.Fatal("no row stored")
	}
	return f.rows[len(f.rows)-1]
}

func (f *fakePG) refuseEveryRow(code string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refuse = code
}

func (f *fakePG) count() (rows, probes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.rows), f.probes
}

// refusalOf is the SQLSTATE PostgreSQL refuses value with in that column, or "". It is written from PostgreSQL's
// documentation, not from what the store does: 22021 for text that is not UTF-8 or holds 0x00, 22P02 and 22P05 for JSON,
// 54000 for an index entry past 2,704 bytes (the text here does not compress).
func refusalOf(column string, value []byte) string {
	if !utf8.Valid(value) || bytes.IndexByte(value, 0) >= 0 {
		return "22021"
	}
	switch column {
	case "service", "action", "actor_user_id", "target_id":
		if len(value) > 2704-12 {
			return "54000"
		}
	case "before", "after":
		return jsonbRefusal(value)
	}
	return ""
}

// jsonbRefusal reads the strings of a JSON text one escape at a time.
func jsonbRefusal(value []byte) string {
	if !json.Valid(value) {
		return "22P02"
	}
	high := false // the escape before was a first half
	for i := 0; i < len(value); i++ {
		if value[i] != '\\' {
			if high {
				return "22P02"
			}
			continue
		}
		i++
		if value[i] != 'u' {
			if high {
				return "22P02"
			}
			continue
		}
		var code rune
		if _, err := fmt.Sscanf(string(value[i+1:i+5]), "%04x", &code); err != nil {
			return "22P02"
		}
		i += 4
		switch low := code >= 0xDC00 && code <= 0xDFFF; {
		case code == 0:
			return "22P05"
		case low != high:
			return "22P02"
		default:
			high = code >= 0xD800 && code <= 0xDBFF
		}
	}
	return ""
}
