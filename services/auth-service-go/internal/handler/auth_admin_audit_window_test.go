package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// A window written with an offset is the instant it names, in UTC as created_at keeps it: the list and the export
// read the same rows for 04:58:51+09:00 as for 19:58:51Z. A value that is not RFC 3339 still leaves the bound out.
func TestAuditFilterFromQuery_AnOffsetIsTheInstantItNames(t *testing.T) {
	q := url.Values{"since": {"2026-11-18T04:58:51+09:00"}, "until": {"2026-11-18T05:01:52+09:00"}}
	f := auditFilterFromQuery(httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs?"+q.Encode(), nil))
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

	utc := auditFilterFromQuery(httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs?since=2026-11-17T19:58:51Z&until=2026-11-17T20:01:52.5Z", nil))
	if !utc.Since.Equal(f.Since) || !utc.Until.Equal(time.Date(2026, 11, 17, 20, 1, 52, 500000000, time.UTC)) {
		t.Errorf("UTC window = %v … %v", utc.Since, utc.Until)
	}

	bad := auditFilterFromQuery(httptest.NewRequest(http.MethodGet, "/auth/admin/audit-logs?since=yesterday&until=2026-11-18", nil))
	if !bad.Since.IsZero() || !bad.Until.IsZero() {
		t.Errorf("not RFC 3339: %v … %v", bad.Since, bad.Until)
	}
}
