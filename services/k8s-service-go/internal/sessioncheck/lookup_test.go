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
		state := r.value.(auth.SessionState)
		*d = state.Version
		*dest[1].(*[]int64) = state.SignedOut
	case *time.Time:
		*d = r.value.(time.Time)
	}
	return nil
}

// tables answers by which table a query reads; "auth_users" is the session state's statement.
type tables map[string]row

func (t tables) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if strings.Contains(sql, "auth_users") && sql != auth.SessionStateQuery {
		return row{err: errors.New("not the session state statement: " + sql)}
	}
	for name, r := range t {
		if strings.Contains(sql, name) {
			return r
		}
	}
	return row{err: errors.New("unexpected query: " + sql)}
}

func TestLookupAnswersTheUsersCurrentVersion(t *testing.T) {
	got, err := Lookup(tables{"auth_users": {value: auth.SessionState{Version: 7}}})(context.Background(), "u1", "")
	if err != nil || got.Version != 7 || len(got.SignedOut) != 0 {
		t.Fatalf("got %+v, %v", got, err)
	}
}

// One statement answers the version and the sign-ins signed out, so a check costs what it did.
func TestLookupAnswersTheSignedOutSignInsInTheSameStatement(t *testing.T) {
	want := auth.SessionState{Version: 2, SignedOut: []int64{1763100000, 1763100042}}
	got, err := Lookup(tables{"auth_users": {value: want}})(context.Background(), "u1", "")
	if err != nil || got.Version != 2 || len(got.SignedOut) != 2 || got.SignedOut[1] != 1763100042 {
		t.Fatalf("got %+v, %v", got, err)
	}
	if !strings.Contains(auth.SessionStateQuery, "ended_sign_ins") {
		t.Fatalf("the statement reads no signed-out sign-ins: %s", auth.SessionStateQuery)
	}
}

func TestLookupSaysADeletedUserIsGone(t *testing.T) {
	_, err := Lookup(tables{"auth_users": {err: pgx.ErrNoRows}})(context.Background(), "u1", "")
	if !errors.Is(err, auth.ErrSubjectGone) {
		t.Fatalf("err = %v", err)
	}
}

func TestLookupSaysADeletedOrExpiredKeyIsGone(t *testing.T) {
	users := row{value: auth.SessionState{Version: 1}}
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
	got, err := Lookup(tables{"api_keys": {value: time.Now().Add(time.Hour)}, "auth_users": {value: auth.SessionState{Version: 3}}})(context.Background(), "u1", "k1")
	if err != nil || got.Version != 3 {
		t.Fatalf("got %+v, %v", got, err)
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
