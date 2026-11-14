package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/k8s-service-go/internal/k8s"
)

// A changes view's window is the one asked for to the second, the four hours before now when none is, cut at now; a
// time that is none, a start not before the end or past 90 days and a limit out of 1 to 50 are refused with why.
func TestTimelineChangesWindow(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	ask := func(query string) (time.Time, time.Time, int, error) {
		return timelineChangesWindow(httptest.NewRequest(http.MethodGet, "/api/v1/timeline/changes"+query, nil), now)
	}

	since, until, limit, err := ask("")
	if err != nil || !until.Equal(now) || !since.Equal(now.Add(-4*time.Hour)) || limit != k8s.TimelineChangesMax {
		t.Fatalf("default: %s to %s, limit %d, %v", since, until, limit, err)
	}
	since, until, limit, err = ask("?since=2026-11-14T08:00:15Z&until=2026-11-14T10:30:45Z&limit=7")
	if err != nil || since.Format(time.RFC3339) != "2026-11-14T08:00:15Z" || until.Format(time.RFC3339) != "2026-11-14T10:30:45Z" || limit != 7 {
		t.Fatalf("asked: %s to %s, limit %d, %v", since, until, limit, err)
	}
	if since, until, _, err = ask("?until=2026-11-15T00:00:00Z"); err != nil || !until.Equal(now) || !since.Equal(now.Add(-4*time.Hour)) {
		t.Fatalf("an end after now: %s to %s, %v", since, until, err)
	}
	for _, query := range []string{
		"?since=yesterday",
		"?until=12:00",
		"?since=2026-11-14T13:00:00Z",
		"?since=2026-11-14T11:00:00Z&until=2026-11-14T10:00:00Z",
		"?since=2026-01-01T00:00:00Z",
		"?limit=51",
		"?limit=0",
		"?limit=x",
	} {
		if _, _, _, err := ask(query); err == nil {
			t.Errorf("%s: no error", query)
		}
	}
}
