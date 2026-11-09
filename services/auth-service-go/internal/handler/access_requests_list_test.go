package handler

import (
	"net/url"
	"testing"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
)

func TestAccessRequestListFilter(t *testing.T) {
	read := func(raw string) (repository.AccessRequestFilter, error) {
		q, _ := url.ParseQuery(raw)
		return accessRequestListFilter(q)
	}
	f, err := read("")
	if err != nil || f != (repository.AccessRequestFilter{Limit: 200}) {
		t.Errorf("no query = %+v, %v; want the 200 newest of every status", f, err)
	}
	f, err = read("status=decided&q=%20Alice%20&limit=25&offset=50&cluster=self")
	if err != nil || f != (repository.AccessRequestFilter{Status: "decided", Query: "Alice", Limit: 25, Offset: 50}) {
		t.Errorf("a page = %+v, %v", f, err)
	}
	if f, err = read("status=pending&limit=0"); err != nil || f.Limit != 0 {
		t.Errorf("limit=0 (count only) = %+v, %v", f, err)
	}
	for _, bad := range []string{"limit=501", "limit=-1", "limit=x", "offset=-1", "offset=1.5"} {
		if _, err := read(bad); err == nil {
			t.Errorf("%s: want an error", bad)
		}
	}
}

// The signed-in user's own list pages like the admin list, always narrowed to that user, and answers the newest
// 50 to a caller that names no page.
func TestMyAccessRequestListFilterPagesTheUsersOwnRequests(t *testing.T) {
	read := func(raw string) (repository.AccessRequestFilter, error) {
		q, _ := url.ParseQuery(raw)
		return myAccessRequestListFilter(q, "user-1")
	}
	f, err := read("")
	if err != nil || f != (repository.AccessRequestFilter{UserID: "user-1", Limit: 50}) {
		t.Errorf("no query = %+v, %v; want the user's 50 newest", f, err)
	}
	f, err = read("limit=10&offset=50")
	if err != nil || f != (repository.AccessRequestFilter{UserID: "user-1", Limit: 10, Offset: 50}) {
		t.Errorf("the sixth page of ten = %+v, %v", f, err)
	}
	// the admin list's filters do not widen the user's own list
	f, err = read("limit=10&status=pending&q=someone-else&user_id=user-2")
	if err != nil || f != (repository.AccessRequestFilter{UserID: "user-1", Limit: 10}) {
		t.Errorf("other filters = %+v, %v; want only the user's own", f, err)
	}
	if f, err = read("limit=0"); err != nil || f.Limit != 0 {
		t.Errorf("limit=0 (count only) = %+v, %v", f, err)
	}
	for _, bad := range []string{"limit=501", "limit=-1", "limit=x", "offset=-1", "offset=1.5"} {
		if _, err := read(bad); err == nil {
			t.Errorf("%s: want an error", bad)
		}
	}
}
