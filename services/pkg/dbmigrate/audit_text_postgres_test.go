package dbmigrate

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/junginho0901/kubeast/services/pkg/audit"
)

// On a real database: a row is stored whatever text it holds, the shared cases among them; what the table took before it
// holds as it was; and the longest text an indexed column always takes is the one the store cuts to.
func TestPostgresARowIsStoredWhateverTextItHolds(t *testing.T) {
	pool := freshDatabase(t)
	ctx := context.Background()
	if _, err := Up(ctx, pool); err != nil {
		t.Fatalf("Up: %v", err)
	}
	store := audit.NewPostgresStore(pool, audit.ServiceK8s)
	read := func(t *testing.T, id int64) *audit.Entry {
		t.Helper()
		e, err := store.Get(ctx, id)
		if err != nil || e == nil {
			t.Fatalf("read: %v", err)
		}
		return e
	}

	raw, err := os.ReadFile("../../ai-service/tests/fixtures/audit_text_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases struct {
		JSON []struct{ Name, Input, Want string }
	}
	if err := json.Unmarshal(raw, &cases); err != nil || len(cases.JSON) == 0 {
		t.Fatal("no cases read", err)
	}
	for _, c := range cases.JSON {
		t.Run(c.Name, func(t *testing.T) {
			id, err := store.Write(ctx, audit.Record{Action: "k8s.yaml.apply", Before: json.RawMessage(c.Input), After: json.RawMessage(c.Input)})
			if err != nil {
				t.Fatalf("not stored: %v", err)
			}
			var same bool
			if err := pool.QueryRow(ctx, `SELECT before = $2::jsonb AND after = $2::jsonb FROM auth_audit_logs WHERE id = $1`, id, c.Want).Scan(&same); err != nil || !same {
				t.Errorf("the row does not hold %s: %v", c.Want, err)
			}
		})
	}

	bad := "a\xff\x00\xed\xa0\x80b"
	id, err := store.Write(ctx, audit.Record{Action: bad, ActorUserID: bad, ActorEmail: bad, TargetID: bad, TargetType: bad, Cluster: bad, Namespace: bad,
		Result: bad, Error: bad, RequestIP: bad, UserAgent: bad, RequestID: bad, Path: bad, After: json.RawMessage("{\"v\":\"" + "\xff\"}")})
	if err != nil {
		t.Fatalf("not stored: %v", err)
	}
	if e := read(t, id); e.Path != "a\ufffd\ufffd\ufffd\ufffdb" || e.TargetID != e.Path {
		t.Errorf("path = %q, target = %q", e.Path, e.TargetID)
	}
	for name, after := range map[string]string{"not JSON": "name: a", "cut short": `{"a":`} {
		if _, err := store.Write(ctx, audit.Record{Action: "k8s.yaml.apply", After: json.RawMessage(after)}); err != nil {
			t.Errorf("%s is not stored: %v", name, err)
		}
	}

	// text that does not compress, as a caller can send
	r := rand.New(rand.NewSource(3))
	noise := func(n int) string {
		const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
		b := make([]byte, n)
		for i := range b {
			b[i] = letters[r.Intn(len(letters))]
		}
		return string(b)
	}
	long := noise(20000)
	id, err = store.Write(ctx, audit.Record{Action: long, Service: long, ActorUserID: long, TargetID: long, TargetType: "cluster", Cluster: long, UserAgent: long, Path: long})
	if err != nil {
		t.Fatalf("not stored: %v", err)
	}
	e := read(t, id)
	if n := len(e.TargetID); !strings.HasPrefix(long, e.TargetID) || n != 2692 || e.Action != e.TargetID || e.ActorUserID != e.TargetID || e.Service != e.TargetID {
		t.Errorf("an indexed column holds %d bytes", n)
	}
	if e.Cluster != long || e.UserAgent != long || e.Path != long {
		t.Error("a column without an index was cut")
	}
	fits := noise(2692)
	if _, err := pool.Exec(ctx, `INSERT INTO auth_audit_logs (action, target_id) VALUES ('a', $1)`, fits); err != nil {
		t.Errorf("the table refuses 2692 bytes: %v", err)
	}
	var refused *pgconn.PgError
	if _, err := pool.Exec(ctx, `INSERT INTO auth_audit_logs (action, target_id) VALUES ('a', $1)`, noise(2693)); !errors.As(err, &refused) || refused.Code != "54000" {
		t.Errorf("the table takes 2693 bytes, or refuses them another way: %v", err)
	}

	// what PostgreSQL itself refuses, so that the codes the gate reads are the ones it answers
	for code, sql := range map[string]string{
		"22021": `INSERT INTO auth_audit_logs (action, path) VALUES ('a', convert_from('\xff', 'UTF8'))`,
		"22P05": `INSERT INTO auth_audit_logs (action, after) VALUES ('a', '{"a":"\u0000"}')`,
		"22P02": `INSERT INTO auth_audit_logs (action, after) VALUES ('a', '{"a":"\ud800"}')`,
	} {
		if _, err := pool.Exec(ctx, sql); !errors.As(err, &refused) || refused.Code != code {
			t.Errorf("want %s: %v", code, err)
		}
	}

	// the ids running out is the table's state, not the row's text
	if _, err := pool.Exec(ctx, `ALTER SEQUENCE auth_audit_logs_id_seq MAXVALUE 5000 RESTART WITH 5000`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `SELECT nextval('auth_audit_logs_id_seq')`); err != nil {
		t.Fatal(err)
	}
	g := audit.Guard(store, store, true)
	if err := g.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Write(ctx, audit.Record{Action: "k8s.pod.delete"}); err == nil {
		t.Fatal("stored without an id")
	}
	if err := g.Ready(ctx); !errors.Is(err, audit.ErrUnavailable) {
		t.Fatalf("ready = %v", err)
	}
}
