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
