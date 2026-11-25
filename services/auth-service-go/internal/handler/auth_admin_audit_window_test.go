package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// A window written with an offset is the instant it names, in UTC as created_at keeps it: the list and the export
// read the same rows for 04:58:51+09:00 as for 19:58:51Z.
func TestAuditFilterFromQuery_AnOffsetIsTheInstantItNames(t *testing.T) {
	q := url.Values{"since": {"2026-11-18T04:58:51+09:00"}, "until": {"2026-11-18T05:01:52+09:00"}}
	f, err := auditFilterFromQuery(httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs?"+q.Encode(), nil))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name string
		got  time.Time
		want time.Time
	}{
		{"since", f.Since, time.Date(2026, 11, 17, 19, 58, 51, 0, time.UTC)},
		{"until", f.Until, time.Date(2026, 11, 17, 20, 1, 52, 0, time.UTC)},
	} {
		if c.got.Location() != time.UTC || !c.got.Equal(c.want) {
			t.Errorf("%s = %v, want %v", c.name, c.got, c.want)
		}
	}

	utc, err := auditFilterFromQuery(httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs?since=2026-11-17T19:58:51Z&until=2026-11-17T20:01:52.5Z", nil))
	if err != nil || !utc.Since.Equal(f.Since) || !utc.Until.Equal(time.Date(2026, 11, 17, 20, 1, 52, 500000000, time.UTC)) {
		t.Errorf("UTC window = %v … %v (%v)", utc.Since, utc.Until, err)
	}
}

// A since or until that is not RFC 3339 is a 400 that names it, on the list and on the export, before any read and
// with no row, as AI Usage answers: "+09:00" sent unencoded arrives as " 09:00", and leaving that bound out would
// answer every row.
func TestABadAuditWindowIsRefused(t *testing.T) {
	for _, c := range []struct{ query, reason string }{
		{"since=2026-11-18T04:58:51+09:00", "since must be an RFC 3339 time"},
		{"since=yesterday", "since must be an RFC 3339 time"},
		{"until=2026-11-18", "until must be an RFC 3339 time"},
		{"since=2026-11-17T19:58:51Z&until=2026-11-18T05:01:52+09:00", "until must be an RFC 3339 time"},
	} {
		for _, ep := range []struct {
			path, perm string
			call       func(h *AuthHandler, w http.ResponseWriter, r *http.Request)
		}{
			{"/auth/admin/audit-logs", "admin.audit.read", (*AuthHandler).AdminListAuditLogs},
			{"/auth/admin/audit-logs/export", "admin.audit.export", (*AuthHandler).AdminExportAuditLogs},
		} {
			store := &memAuditStore{entries: newestFirst(3)}
			r := httptest.NewRequest(http.MethodGet, ep.path+"?"+c.query, nil)
			r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {ep.perm}}}))
			w := httptest.NewRecorder()
			ep.call(&AuthHandler{auditStore: store}, w, r)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), c.reason) {
				t.Errorf("%s?%s: %d %s, want 400 %q", ep.path, c.query, w.Code, w.Body.String(), c.reason)
			}
			if store.lists != 0 || len(store.written) != 0 {
				t.Errorf("%s?%s: %d reads, %d rows written, want none", ep.path, c.query, store.lists, len(store.written))
			}
		}
	}
}

// The AI Usage read's row keeps the period in UTC, the instant that was asked, as the audit list's row keeps its
// filter; the answer still echoes the period as it was sent.
func TestAIUsageReadRowKeepsThePeriodInUTC(t *testing.T) {
	kst := time.FixedZone("KST", 9*60*60)
	raw := aiUsageReadAfter(time.Date(2026, 11, 18, 4, 58, 51, 0, kst), time.Date(2026, 11, 18, 5, 1, 52, 0, kst), "user", 0, false)
	var after struct{ Since, Until string }
	if err := json.Unmarshal(raw, &after); err != nil {
		t.Fatal(err)
	}
	if after.Since != "2026-11-17T19:58:51Z" || after.Until != "2026-11-17T20:01:52Z" {
		t.Errorf("row period = %s … %s, want 2026-11-17T19:58:51Z … 2026-11-17T20:01:52Z", after.Since, after.Until)
	}
}

// A text filter with a byte no row can hold (0x00, or one that is not UTF-8) is a 400 that names it, on the list and on
// the export, before any read and with no row: PostgreSQL refuses a query that names one, and the answer was a 500. The
// AI tool refuses such a value too (tool-server argcheck). Any text a row can hold goes to the store as it was sent.
func TestAnAuditFilterNoRowCanHoldIsRefused(t *testing.T) {
	for _, ep := range []struct {
		path, perm string
		call       func(h *AuthHandler, w http.ResponseWriter, r *http.Request)
	}{
		{"/auth/admin/audit-logs", "admin.audit.read", (*AuthHandler).AdminListAuditLogs},
		{"/auth/admin/audit-logs/export", "admin.audit.export", (*AuthHandler).AdminExportAuditLogs},
	} {
		ask := func(query string) (*memAuditStore, *httptest.ResponseRecorder) {
			store := &memAuditStore{entries: newestFirst(3)}
			r := httptest.NewRequest(http.MethodGet, ep.path+"?"+query, nil)
			r = r.WithContext(auth.WithPayload(r.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: auth.PermissionMatrix{"*": {ep.perm}}}))
			w := httptest.NewRecorder()
			ep.call(&AuthHandler{auditStore: store}, w, r)
			return store, w
		}
		for _, name := range []string{"service", "action", "actor_email", "target_id", "cluster", "namespace", "result"} {
			for _, value := range []string{"%00", "web%00", "%FF", "a%C3", "%ED%A0%80"} {
				store, w := ask("service=k8s&" + name + "=" + value)
				if name == "service" {
					store, w = ask(name + "=" + value)
				}
				if want := name + " must be UTF-8 text without 0x00"; w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), want) {
					t.Errorf("%s?%s=%s: %d %s, want 400 %q", ep.path, name, value, w.Code, w.Body.String(), want)
				}
				if store.lists != 0 || len(store.written) != 0 {
					t.Errorf("%s?%s=%s: %d reads, %d rows written, want none", ep.path, name, value, store.lists, len(store.written))
				}
			}
			for _, value := range []string{"web", "a b", "\uac00\uff0c", "\ufffd", "\x01\t", "\U0001f600"} {
				if store, w := ask(url.Values{name: {value}}.Encode()); w.Code != http.StatusOK || store.lists == 0 || len(store.written) != 1 {
					t.Errorf("%s?%s=%q: %d, %d reads, %d rows written, want 200, read and recorded", ep.path, name, value, w.Code, store.lists, len(store.written))
				}
			}
		}
	}
	q := url.Values{"service": {"k8s"}, "action": {"k8s.pod.delete"}, "actor_email": {"a b"}, "target_id": {"web"}, "cluster": {"c"}, "namespace": {"shop"}, "result": {"failure"}}
	f, err := auditFilterFromQuery(httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs?"+q.Encode(), nil))
	if err != nil || f.Service != "k8s" || f.Action != "k8s.pod.delete" || f.ActorEmail != "a b" || f.TargetID != "web" || f.Cluster != "c" || f.Namespace != "shop" || f.Result != "failure" {
		t.Errorf("the filter read is %+v (%v)", f, err)
	}
}
