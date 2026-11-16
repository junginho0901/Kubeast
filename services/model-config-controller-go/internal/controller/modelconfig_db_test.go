package controller

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/stdlib"
)

// queryRecorder is a stand-in PostgreSQL server that keeps each startup message's parameters and every simple query
// and answers each query with an empty result.
type queryRecorder struct {
	addr     string
	mu       sync.Mutex
	startups []map[string]string
	queries  []string
}

func startQueryRecorder(t *testing.T) *queryRecorder {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	r := &queryRecorder{addr: ln.Addr().String()}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go r.serve(c)
		}
	}()
	return r
}

func (r *queryRecorder) serve(c net.Conn) {
	defer c.Close()
	be := pgproto3.NewBackend(c, c)
	msg, err := be.ReceiveStartupMessage()
	if err != nil {
		return
	}
	if sm, ok := msg.(*pgproto3.StartupMessage); ok {
		r.mu.Lock()
		r.startups = append(r.startups, sm.Parameters)
		r.mu.Unlock()
	}
	be.Send(&pgproto3.AuthenticationOk{})
	be.Send(&pgproto3.ParameterStatus{Name: "client_encoding", Value: "UTF8"})
	be.Send(&pgproto3.ParameterStatus{Name: "standard_conforming_strings", Value: "on"})
	be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if be.Flush() != nil {
		return
	}
	for {
		msg, err := be.Receive()
		if err != nil {
			return
		}
		switch m := msg.(type) {
		case *pgproto3.Query:
			r.mu.Lock()
			r.queries = append(r.queries, m.String)
			r.mu.Unlock()
			tag := "SELECT 0"
			if f := strings.Fields(m.String); len(f) > 0 && !strings.HasPrefix(f[0], "--") {
				tag = strings.ToUpper(f[0])
			}
			be.Send(&pgproto3.CommandComplete{CommandTag: []byte(tag)})
			be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
			if be.Flush() != nil {
				return
			}
		case *pgproto3.Terminate:
			return
		}
	}
}

func clearDBLimitVars(t *testing.T) {
	t.Helper()
	for _, l := range dbSessionLimits {
		t.Setenv(l.env, "")
	}
	t.Setenv(envDBPoolMaxConns, "")
}

// O-27: the controller's connections set no session limits (PostgreSQL's default is 0, no limit for each). They are
// SET once a connection is made, not sent in the startup message.
func TestDBConnectionSetsTheSessionLimitsAfterConnecting(t *testing.T) {
	clearDBLimitVars(t)
	srv := startQueryRecorder(t)
	cfg, err := dbConnConfig(fmt.Sprintf("postgresql+asyncpg://test@%s/test?sslmode=disable", srv.addr))
	if err != nil {
		t.Fatalf("dbConnConfig: %v", err)
	}
	if len(cfg.RuntimeParams) != 0 {
		t.Fatalf("RuntimeParams = %v, want none", cfg.RuntimeParams)
	}
	db := stdlib.OpenDB(*cfg)
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	want := "SET statement_timeout = 30000; SET lock_timeout = 15000; SET idle_in_transaction_session_timeout = 300000"
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if len(srv.queries) == 0 || srv.queries[0] != want {
		t.Fatalf("first query = %q, want %q", srv.queries, want)
	}
	for _, s := range srv.startups {
		if v, ok := s["statement_timeout"]; ok {
			t.Fatalf("startup message holds statement_timeout=%q", v)
		}
	}
}

func TestDBSessionStatementsReadTheVariables(t *testing.T) {
	clearDBLimitVars(t)
	t.Setenv("DB_STATEMENT_TIMEOUT_MS", "45000")
	t.Setenv("DB_LOCK_TIMEOUT_MS", "0")
	t.Setenv("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS", "-5")
	if got, want := dbSessionStatements(), "SET statement_timeout = 45000; SET idle_in_transaction_session_timeout = 300000"; got != want {
		t.Fatalf("dbSessionStatements() = %q, want %q", got, want)
	}
	for _, l := range dbSessionLimits {
		t.Setenv(l.env, "0")
	}
	cfg, err := dbConnConfig("postgres://kubeast:pw@db.example:5432/kubeast")
	if err != nil {
		t.Fatalf("dbConnConfig: %v", err)
	}
	if cfg.AfterConnect != nil {
		t.Fatal("AfterConnect set with every limit 0")
	}
}

func TestDBPoolMaxConns(t *testing.T) {
	for v, want := range map[string]int{"": 4, "6": 6, "0": 4, "-1": 4, "x": 4} {
		t.Setenv(envDBPoolMaxConns, v)
		if got := dbPoolMaxConns(); got != want {
			t.Fatalf("%s=%q gives %d, want %d", envDBPoolMaxConns, v, got, want)
		}
	}
}

// The controller's copy of the session limits keeps services/pkg/dbsession's variable names and defaults.
func TestDBSessionLimitsFollowTheSharedPackage(t *testing.T) {
	want := map[string]int{
		"DB_STATEMENT_TIMEOUT_MS":           30000,
		"DB_LOCK_TIMEOUT_MS":                15000,
		"DB_IDLE_IN_TRANSACTION_TIMEOUT_MS": 300000,
	}
	if len(dbSessionLimits) != len(want) {
		t.Fatalf("%d limits, want %d", len(dbSessionLimits), len(want))
	}
	for _, l := range dbSessionLimits {
		if want[l.env] != l.def {
			t.Fatalf("%s default %d, want %d (services/pkg/dbsession.Defaults)", l.env, l.def, want[l.env])
		}
	}
}

// The controller is built without the shared services/pkg module, so its copy
// of the required schema version must follow dbmigrate.Required by hand.
func TestRequiredSchemaVersion(t *testing.T) {
	if requiredSchemaVersion != 3 {
		t.Fatalf("requiredSchemaVersion = %d; keep it equal to services/pkg/dbmigrate.Required", requiredSchemaVersion)
	}
}
