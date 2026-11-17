package main

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A database that restarts signs nobody out. While what a token is checked against cannot be read, auth-service
// refuses the token with 503 and Retry-After — it does not take it on trust — and answers the other services'
// token-version reads with 503, which they bridge from what they last read, where 404 would revoke. A user who is
// gone stays 401 on the routes and 404 on the token-version read. A key or owner that cannot be read is no invalid key:
// the exchange answers 503 too and leaves its audit row.
func TestADatabaseThatCannotBeReadRefusesWith503AndSignsNobodyOut(t *testing.T) {
	retryAfter := strconv.Itoa(auth.SessionUnreadableRetryAfter)
	text, stamp, list := uint32(pgtype.TextOID), uint32(pgtype.TimestamptzOID), uint32(pgtype.TextArrayOID)
	key := pgRule{match: "FROM api_keys WHERE key_hash", oids: []uint32{text, text, text, text, list, text, stamp, stamp, text, stamp},
		rows: [][]any{{"key-1", "owner", "k", "kbk_test", nil, "Read", time.Now().Add(time.Hour).UTC().Format(pgTimestamp), nil, nil, time.Now().UTC().Format(pgTimestamp)}}}
	for _, c := range []struct {
		name, fails  string
		tokenVersion int
		exchange     string // the audit row's reason of a key exchange, "" when the exchange is not asked
	}{
		{"the session state", "SELECT token_version, ARRAY(", http.StatusServiceUnavailable, ""},
		{"the account", "FROM auth_users u JOIN roles r ON r.id = u.role_id", http.StatusOK, "owner unreadable"},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, key)
			api.db.failOn(c.fails)
			tok := api.sessionToken()
			for _, call := range []struct{ method, path, body string }{
				{http.MethodGet, "/me", ""},
				{http.MethodPost, "/refresh", ""},
				{http.MethodPost, "/change-password", `{"current_password":"` + testPassword + `","new_password":"Another-long-phrase-77"}`},
				{http.MethodPost, "/api-keys", `{"name":"k","expires_in_days":1}`},
			} {
				w := api.call(tok, call.method, call.path, call.body)
				if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != retryAfter {
					t.Errorf("%s %s: %d (Retry-After %q) %s, want 503 with Retry-After %s", call.method, call.path, w.Code, w.Header().Get("Retry-After"), w.Body.String(), retryAfter)
				}
				if strings.Contains(w.Body.String(), "fake database failure") {
					t.Errorf("%s %s: the answer carries the database's words: %s", call.method, call.path, w.Body.String())
				}
			}
			if w := api.call(tok, http.MethodGet, "/internal/token-version/owner", ""); w.Code != c.tokenVersion {
				t.Errorf("token-version: %d %s, want %d", w.Code, w.Body.String(), c.tokenVersion)
			}
			if c.exchange != "" {
				w := api.call("kbk_test", http.MethodPost, "/token", "")
				if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != retryAfter {
					t.Errorf("key exchange: %d (Retry-After %q) %s, want 503", w.Code, w.Header().Get("Retry-After"), w.Body.String())
				}
				if rows := api.store.failures("user.apikey.exchange"); len(rows) != 1 || rows[0].Error != c.exchange {
					t.Errorf("exchange audit rows = %+v, want one failure %q", rows, c.exchange)
				}
			}
		})
	}

	t.Run("the key of an exchange", func(t *testing.T) {
		api := newAuthAPI(t, pendingRequest{owner: "requester"}, key)
		api.db.failOn("FROM api_keys WHERE key_hash")
		w := api.call("kbk_test", http.MethodPost, "/token", "")
		if w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") != retryAfter {
			t.Errorf("key exchange: %d (Retry-After %q) %s, want 503", w.Code, w.Header().Get("Retry-After"), w.Body.String())
		}
		if rows := api.store.failures("user.apikey.exchange"); len(rows) != 1 || rows[0].Error != "key unreadable" {
			t.Errorf("exchange audit rows = %+v, want one failure \"key unreadable\"", rows)
		}
	})

	t.Run("a user who is gone", func(t *testing.T) {
		nobody := pgRule{match: "'nobody'", oids: []uint32{uint32(pgtype.Int4OID), uint32(pgtype.Int8ArrayOID)}}
		api := newAuthAPI(t, pendingRequest{owner: "requester"}, nobody)
		tok, err := api.mgr.CreateToken("nobody", "nobody@example.com", "Member", auth.PermissionMatrix{"c": {readPerm}}, nil, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		if w := api.call(tok, http.MethodGet, "/me", ""); w.Code != http.StatusUnauthorized {
			t.Errorf("/me: %d %s, want 401", w.Code, w.Body.String())
		}
		if w := api.call(tok, http.MethodGet, "/internal/token-version/nobody", ""); w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), `"code":"subject_gone"`) {
			t.Errorf("token-version: %d %s, want 404 marked subject_gone", w.Code, w.Body.String())
		}
	})
}

// A token an API key was exchanged for goes with the key: a key deleted or past its expiry is the user's verdict
// (auth.ErrSubjectGone through SessionStateFor), 401 on the routes and 404 on the token-version read, never the 503 of
// a read that failed, which the other services would bridge for minutes.
func TestATokenOfAKeyThatIsGoneIsRefusedNotBridged(t *testing.T) {
	stamp := uint32(pgtype.TimestamptzOID)
	for _, c := range []struct {
		name string
		row  pgRule
	}{
		{"deleted", pgRule{match: "SELECT expires_at FROM api_keys", oids: []uint32{stamp}}},
		{"past its expiry", pgRule{match: "SELECT expires_at FROM api_keys", oids: []uint32{stamp}, rows: [][]any{{time.Now().Add(-time.Minute).UTC().Format(pgTimestamp)}}}},
	} {
		t.Run(c.name, func(t *testing.T) {
			api := newAuthAPI(t, pendingRequest{owner: "requester"}, c.row)
			tok := api.keyToken()
			if w := api.call(tok, http.MethodGet, "/me", ""); w.Code != http.StatusUnauthorized {
				t.Errorf("/me: %d %s, want 401", w.Code, w.Body.String())
			}
			if w := api.call(tok, http.MethodGet, "/internal/token-version/owner", ""); w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), `{"code":"subject_gone","detail":"API key revoked"}`) {
				t.Errorf("token-version: %d %s, want 404 API key revoked, marked subject_gone", w.Code, w.Body.String())
			}
			if w := api.call(api.sessionToken(), http.MethodGet, "/me", ""); w.Code != http.StatusOK {
				t.Errorf("the owner's own sign-in: %d %s, want 200", w.Code, w.Body.String())
			}
		})
	}
}
