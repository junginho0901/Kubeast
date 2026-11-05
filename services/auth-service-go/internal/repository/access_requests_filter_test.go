package repository

import (
	"reflect"
	"strings"
	"testing"
)

func TestAccessRequestWhere(t *testing.T) {
	cases := []struct {
		name  string
		f     AccessRequestFilter
		where string
		args  []any
	}{
		{"everything", AccessRequestFilter{}, "", nil},
		{"one status", AccessRequestFilter{Status: AccessRequestPending}, " WHERE ar.status = $1", []any{"pending"}},
		{"decided = not pending", AccessRequestFilter{Status: AccessRequestsDecided}, " WHERE ar.status <> $1", []any{"pending"}},
		{"own, one status", AccessRequestFilter{UserID: "u1", Status: AccessRequestRejected}, " WHERE ar.user_id = $1 AND ar.status = $2", []any{"u1", "rejected"}},
	}
	for _, c := range cases {
		where, args := accessRequestWhere(c.f)
		if where != c.where || !reflect.DeepEqual(args, c.args) {
			t.Errorf("%s: where %q args %v, want %q %v", c.name, where, args, c.where, c.args)
		}
	}
}

// The search looks in the fields the page searched in its rows: requester
// name and email, cluster name and id, role, reason, decider email — as text.
func TestAccessRequestWhere_Search(t *testing.T) {
	want := []string{"u.name", "u.email", "c.display_name", "ar.cluster_id", "ro.name", "ar.reason", "d.email"}
	if !reflect.DeepEqual(accessRequestSearchColumns, want) {
		t.Fatalf("search columns = %v, want %v", accessRequestSearchColumns, want)
	}
	where, args := accessRequestWhere(AccessRequestFilter{Status: AccessRequestsDecided, Query: "  Deploy_1%  "})
	if !reflect.DeepEqual(args, []any{"pending", "deploy_1%"}) {
		t.Fatalf("args = %v", args)
	}
	for _, col := range want {
		if !strings.Contains(where, "strpos(lower(COALESCE("+col+", '')), $2) > 0") {
			t.Errorf("where %q does not search %s as text", where, col)
		}
	}
	if strings.Contains(strings.ToUpper(where), "LIKE") {
		t.Errorf("where %q treats %% and _ as wildcards", where)
	}
	if !strings.HasPrefix(where, " WHERE ar.status <> $1 AND (") {
		t.Errorf("where %q: the search must narrow the status, not widen it", where)
	}
}

func TestAccessRequestOrderHasATieBreak(t *testing.T) {
	if accessRequestOrder != " ORDER BY ar.created_at DESC, ar.id DESC" {
		t.Errorf("order = %q", accessRequestOrder)
	}
}
