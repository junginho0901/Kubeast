package sessioncheck

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// row answers one Scan with a value or an error.
type row struct {
	value any
	err   error
}

func (r row) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	switch d := dest[0].(type) {
	case *int:
		*d = r.value.(int)
	case *time.Time:
		*d = r.value.(time.Time)
	}
	return nil
}

// tables answers by which table a query reads.
type tables map[string]row

func (t tables) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	for name, r := range t {
		if strings.Contains(sql, name) {
			return r
		}
	}
	return row{err: errors.New("unexpected query: " + sql)}
}

func TestLookupAnswersTheUsersCurrentVersion(t *testing.T) {
	got, err := Lookup(tables{"auth_users": {value: 7}})(context.Background(), "u1", "")
	if err != nil || got != 7 {
		t.Fatalf("got %d, %v", got, err)
	}
}

func TestLookupSaysADeletedUserIsGone(t *testing.T) {
	_, err := Lookup(tables{"auth_users": {err: pgx.ErrNoRows}})(context.Background(), "u1", "")
	if !errors.Is(err, auth.ErrSubjectGone) {
		t.Fatalf("err = %v", err)
	}
}

func TestLookupSaysADeletedOrExpiredKeyIsGone(t *testing.T) {
	users := row{value: 1}
	for name, key := range map[string]row{
		"deleted": {err: pgx.ErrNoRows},
		"expired": {value: time.Now().Add(-time.Minute)},
	} {
		_, err := Lookup(tables{"api_keys": key, "auth_users": users})(context.Background(), "u1", "k1")
		if !errors.Is(err, auth.ErrSubjectGone) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestLookupReadsTheVersionForALiveKey(t *testing.T) {
	got, err := Lookup(tables{"api_keys": {value: time.Now().Add(time.Hour)}, "auth_users": {value: 3}})(context.Background(), "u1", "k1")
	if err != nil || got != 3 {
		t.Fatalf("got %d, %v", got, err)
	}
}

func TestLookupPassesOnAnOutageAsAnOutage(t *testing.T) {
	down := errors.New("connection refused")
	for name, tb := range map[string]tables{
		"users": {"auth_users": {err: down}},
		"keys":  {"api_keys": {err: down}},
	} {
		key := ""
		if name == "keys" {
			key = "k1"
		}
		_, err := Lookup(tb)(context.Background(), "u1", key)
		if !errors.Is(err, down) || errors.Is(err, auth.ErrSubjectGone) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
