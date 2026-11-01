package github

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCloneTokenReadsOneRepository(t *testing.T) {
	e := newEnv(t)
	// The app's own narrowing is for the controller's token, not the clone.
	e.app.Permissions = map[string]string{"contents": "read", "checks": "write", "metadata": "read"}
	ctx := context.Background()
	t1, err := e.app.CloneToken(ctx, installation, "acme/web")
	if err != nil {
		t.Fatal(err)
	}
	if got := e.gh.tokenBodies[0]; got != `{"permissions":{"contents":"read"},"repositories":["web"]}` {
		t.Errorf("clone token request body %s", got)
	}
	if !t1.ExpiresAt.Equal(e.now.Add(time.Hour).Truncate(time.Second)) {
		t.Errorf("expires %s", t1.ExpiresAt)
	}
	t2, err := e.app.CloneToken(ctx, installation, "acme/web")
	if err != nil || t2 == t1 || e.gh.tokenCalls != 2 {
		t.Fatalf("a second build got the same token (%d calls, %v)", e.gh.tokenCalls, err)
	}
	// The controller's cached token is a separate one.
	if tok, err := e.app.InstallationToken(ctx, installation); err != nil || tok == t1 || tok == t2 {
		t.Fatalf("installation token %v %v", tok, err)
	}
	for _, bad := range []struct {
		inst int64
		repo string
	}{{0, "acme/web"}, {installation, "web"}, {installation, "acme/web/x"}, {installation, "acme/"}, {installation, "../web"}} {
		if _, err := e.app.CloneToken(ctx, bad.inst, bad.repo); err == nil {
			t.Errorf("%d %q accepted", bad.inst, bad.repo)
		}
	}
	if e.gh.tokenCalls != 3 {
		t.Errorf("refused requests reached GitHub (%d calls)", e.gh.tokenCalls)
	}
	if strings.Contains(t1.String(), t1.Value) {
		t.Error("String shows the token")
	}
}

// TestSplitRepoRefusesDots: the parts go into REST paths.
func TestSplitRepoRefusesDots(t *testing.T) {
	for _, bad := range []string{"../web", "acme/..", "./web", "acme/.", ".../web"} {
		if _, _, err := splitRepo(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	for _, good := range []string{"acme/web", "acme/.github", "a.b/c.d", "acme/web.js"} {
		if _, _, err := splitRepo(good); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
}
