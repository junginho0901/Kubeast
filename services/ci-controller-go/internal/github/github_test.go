package github

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vektah/gqlparser/v2"
	"github.com/vektah/gqlparser/v2/ast"

	"github.com/junginho0901/kubeast/services/ci-controller-go/internal/poll"
)

var testKey = sync.OnceValue(func() *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return k
})

const (
	appID        = "Iv23liTestClientID"
	installation = 42
	sha1         = "6113728f27ae82c7b1a177c8d03f9e96e0adf246"
	sha2         = "ec26c3e57ca3a959ca5aad62de7213c562f8c821"
	sha3         = "0123456789abcdef0123456789abcdef01234567"
)

type env struct {
	gh     *fakeGitHub
	srv    *httptest.Server
	app    *App
	client *Client
	now    time.Time
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{now: time.Date(2026, 11, 1, 7, 0, 0, 0, time.UTC)}
	e.gh = &fakeGitHub{t: t, appID: appID, key: &testKey().PublicKey, now: func() time.Time { return e.now }, repos: map[string]*fakeRepo{
		"acme/web": {
			id:       186853002,
			branches: []fakeRef{{name: "main", sha: sha1}, {name: "release/1.2", sha: sha2}, {name: "feature/x", sha: sha3}},
			tags:     []fakeRef{{name: "v1.1.0", sha: sha2, annotated: true}, {name: "v1.0.0", sha: sha3}},
			prs:      []fakePR{{number: 7, head: sha3, base: "main", fork: true}, {number: 8, head: sha2, base: "main", draft: true}},
			commits:  map[string]bool{sha1: true, sha2: true},
			files: map[string]map[string]string{
				sha1: {PipelinePath: "apiVersion: kubeast.io/pipeline/v1alpha1\n", "docs": "<dir>", "logo.png": "<binary>", "big.txt": "<truncated>"},
			},
		},
	}}
	e.srv = httptest.NewServer(e.gh)
	t.Cleanup(e.srv.Close)
	e.app = &App{ID: appID, Key: testKey(), BaseURL: e.srv.URL, HTTP: e.srv.Client(), Now: func() time.Time { return e.now }}
	e.client = &Client{App: e.app, Installation: installation, GraphQLURL: e.srv.URL + "/graphql"}
	return e
}

func TestJWT(t *testing.T) {
	e := newEnv(t)
	jwt, err := e.app.JWT()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.gh.checkJWT(jwt); err != nil {
		t.Fatalf("GitHub's checks refuse the JWT: %v", err)
	}
	var claims struct{ Iat, Exp int64 }
	part, _ := base64.RawURLEncoding.DecodeString(strings.Split(jwt, ".")[1])
	json.Unmarshal(part, &claims)
	if now := e.now.Unix(); claims.Iat != now-60 || claims.Exp != now+300 {
		t.Errorf("iat %+d s, exp %+d s from now; want -60 and +300", claims.Iat-now, claims.Exp-now)
	}
	if _, err := (&App{ID: appID}).JWT(); err == nil {
		t.Error("a JWT without a key")
	}
}

func TestInstallationTokenCachedAndRefreshed(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	t1, err := e.app.InstallationToken(ctx, installation)
	if err != nil {
		t.Fatal(err)
	}
	e.now = e.now.Add(49 * time.Minute)
	if t2, _ := e.app.InstallationToken(ctx, installation); t2 != t1 || e.gh.tokenCalls != 1 {
		t.Fatalf("49 minutes in: a new token (%d calls)", e.gh.tokenCalls)
	}
	e.now = e.now.Add(time.Minute + time.Second)
	t3, _ := e.app.InstallationToken(ctx, installation)
	if t3 == t1 || e.gh.tokenCalls != 2 {
		t.Fatalf("10 minutes before expiry: the same token (%d calls)", e.gh.tokenCalls)
	}
	if _, err := e.app.InstallationToken(ctx, 43); err != nil || e.gh.tokenCalls != 3 {
		t.Fatalf("another installation shares the cache: %v, %d calls", err, e.gh.tokenCalls)
	}
	if s := t3.String(); strings.Contains(s, "ghs_") {
		t.Errorf("String shows the token: %s", s)
	}
}

func TestPermissionsNarrowTheToken(t *testing.T) {
	e := newEnv(t)
	e.app.Permissions = map[string]string{"contents": "read", "checks": "write", "metadata": "read"}
	if _, err := e.app.InstallationToken(context.Background(), installation); err != nil {
		t.Fatal(err)
	}
	if got := e.gh.tokenBodies[0]; got != `{"permissions":{"checks":"write","contents":"read","metadata":"read"}}` {
		t.Errorf("token request body %s", got)
	}
}

func TestRefusalsKeepSecretsOut(t *testing.T) {
	e := newEnv(t)
	if _, err := e.app.InstallationToken(context.Background(), installation); err != nil {
		t.Fatal(err)
	}
	e.gh.fail = []failure{{status: 403, headers: map[string]string{"Retry-After": "60"}, message: "You have exceeded a secondary rate limit."}}
	_, _, err := e.client.Heads(context.Background(), []string{"acme/web"})
	var api *APIError
	if !errors.As(err, &api) || api.Status != 403 || !api.RateLimited() || api.RetryAfter != time.Minute {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), "eyJ") || strings.Contains(err.Error(), "ghs_") {
		t.Fatalf("the error shows a credential: %v", err)
	}
	// The token endpoint's refusal is GitHub's message only.
	e2 := newEnv(t)
	e2.app.ID = "wrong-app"
	_, err = e2.app.InstallationToken(context.Background(), installation)
	if !errors.As(err, &api) || api.Status != 401 || strings.Contains(err.Error(), "eyJ") {
		t.Fatalf("token refusal: %v", err)
	}
}

func TestUnauthorizedIsTriedOnceWithANewToken(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.app.InstallationToken(ctx, installation); err != nil {
		t.Fatal(err)
	}
	e.gh.mu.Lock()
	e.gh.tokens = map[string]int64{} // GitHub forgot the token (revoked)
	e.gh.mu.Unlock()
	if _, _, err := e.client.Heads(ctx, []string{"acme/web"}); err != nil {
		t.Fatalf("after a 401: %v", err)
	}
	if e.gh.tokenCalls != 2 {
		t.Fatalf("token calls %d, want 2", e.gh.tokenCalls)
	}
	// A second 401 in a row is an error, not a loop.
	e.gh.fail = []failure{{status: 401, message: "Bad credentials"}, {status: 401, message: "Bad credentials"}}
	if _, _, err := e.client.Heads(ctx, []string{"acme/web"}); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("two 401s: %v", err)
	}
}

func TestHeads(t *testing.T) {
	e := newEnv(t)
	big := &fakeRepo{id: 9, commits: map[string]bool{}}
	for i := 0; i < 250; i++ {
		big.branches = append(big.branches, fakeRef{name: fmt.Sprintf("b%03d", i), sha: sha1})
	}
	for i := 1; i <= 130; i++ {
		big.prs = append(big.prs, fakePR{number: i, head: sha2, base: "main"})
	}
	e.gh.repos["acme/big"] = big
	e.gh.repos["acme/old"] = &fakeRepo{id: 10, archived: true, branches: []fakeRef{{name: "main", sha: sha3}}}

	heads, rl, err := e.client.Heads(context.Background(), []string{"acme/web", "acme/big", "acme/gone", "acme/old"})
	if err != nil {
		t.Fatal(err)
	}
	web := heads["acme/web"]
	want := RepoHeads{Repo: "acme/web", RepoID: 186853002,
		Branches:     map[string]string{"main": sha1, "release/1.2": sha2, "feature/x": sha3},
		Tags:         map[string]string{"v1.1.0": sha2, "v1.0.0": sha3},
		PullRequests: []PullRequest{{Number: 7, HeadSHA: sha3, Base: "main", Fork: true}, {Number: 8, HeadSHA: sha2, Base: "main", Draft: true}},
	}
	if fmt.Sprint(web) != fmt.Sprint(want) {
		t.Errorf("acme/web\n got %+v\nwant %+v", web, want)
	}
	if b := heads["acme/big"]; len(b.Branches) != 250 || len(b.PullRequests) != 130 || b.Truncated {
		t.Errorf("acme/big: %d branches, %d pull requests, truncated %v", len(b.Branches), len(b.PullRequests), b.Truncated)
	}
	if g := heads["acme/gone"]; !g.Missing {
		t.Errorf("acme/gone: %+v, want missing", g)
	}
	if o := heads["acme/old"]; !o.Archived || o.Missing {
		t.Errorf("acme/old: %+v, want archived", o)
	}
	// One batch, then the big repository's further pages: branches need two
	// more pages, pull requests one, asked together.
	if got := strings.Join(e.gh.queries, ","); got != "Heads,More,More" {
		t.Errorf("queries %s", got)
	}
	if rl.Limit != 5000 || rl.Remaining != 5000-9 {
		t.Errorf("rate limit %+v (the last answer's)", rl)
	}
	for _, doc := range e.gh.documents {
		for _, name := range []string{"acme", "web", "big", "gone"} {
			if strings.Contains(doc, `"`+name+`"`) {
				t.Errorf("a repository name is in the query text; names are variables only:\n%s", doc)
			}
		}
	}
}

func TestHeadsBatches(t *testing.T) {
	e := newEnv(t)
	var repos []string
	for i := 0; i < 250; i++ {
		name := fmt.Sprintf("acme/r%d", i)
		e.gh.repos[name] = &fakeRepo{id: int64(1000 + i), branches: []fakeRef{{name: "main", sha: sha1}}}
		repos = append(repos, name)
	}
	heads, _, err := e.client.Heads(context.Background(), repos)
	if err != nil {
		t.Fatal(err)
	}
	if len(heads) != 250 || heads["acme/r249"].Branches["main"] != sha1 {
		t.Fatalf("%d heads", len(heads))
	}
	var sizes []int
	for _, doc := range e.gh.documents {
		sizes = append(sizes, strings.Count(doc, ": repository("))
	}
	if fmt.Sprint(sizes) != "[100 100 50]" {
		t.Errorf("batches %v, want [100 100 50]", sizes)
	}
}

func TestHeadsTruncatedAtMaxPages(t *testing.T) {
	e := newEnv(t)
	defer func(n int) { maxPages = n }(maxPages)
	maxPages = 1
	r := &fakeRepo{id: 11}
	for i := 0; i < 350; i++ {
		r.branches = append(r.branches, fakeRef{name: fmt.Sprintf("b%03d", i), sha: sha1})
	}
	e.gh.repos["acme/many"] = r
	heads, _, err := e.client.Heads(context.Background(), []string{"acme/many"})
	if err != nil {
		t.Fatal(err)
	}
	if h := heads["acme/many"]; !h.Truncated || len(h.Branches) != 200 {
		t.Fatalf("truncated %v with %d branches, want true with 200", h.Truncated, len(h.Branches))
	}
}

func TestHeadsOtherRepositoryErrorFails(t *testing.T) {
	e := newEnv(t)
	e.gh.denied = map[string]string{"acme/web": "FORBIDDEN"}
	if _, _, err := e.client.Heads(context.Background(), []string{"acme/web"}); err == nil || !strings.Contains(err.Error(), "FORBIDDEN") {
		t.Fatalf("err = %v, want the FORBIDDEN error, not a missing repository", err)
	}
	if _, _, err := e.client.Heads(context.Background(), []string{"not a repo"}); err == nil {
		t.Fatal("a bad repository name was sent")
	}
}

func TestPipeline(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	f, rl, err := e.client.Pipeline(ctx, "acme/web", sha1, PipelinePath, 64<<10)
	if err != nil || !f.CommitFound || !f.Found || string(f.Data) != "apiVersion: kubeast.io/pipeline/v1alpha1\n" || rl.Limit != 5000 {
		t.Fatalf("pipeline file: %+v, %+v, %v", f, rl, err)
	}
	if f, _, err := e.client.Pipeline(ctx, "acme/web", sha2, PipelinePath, 64<<10); err != nil || !f.CommitFound || f.Found {
		t.Errorf("no pipeline file: %+v, %v (want the commit found, the file not)", f, err)
	}
	if f, _, err := e.client.Pipeline(ctx, "acme/web", sha3, PipelinePath, 64<<10); err != nil || f.CommitFound {
		t.Errorf("unknown commit: %+v, %v", f, err)
	}
	if _, _, err := e.client.Pipeline(ctx, "acme/gone", sha1, PipelinePath, 64<<10); !errors.Is(err, ErrRepoNotFound) {
		t.Errorf("unknown repository: %v", err)
	}
	for path, want := range map[string]string{"docs": "is a Tree", "logo.png": "not text", "big.txt": "cut short"} {
		if _, _, err := e.client.Pipeline(ctx, "acme/web", sha1, path, 64<<10); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", path, err, want)
		}
	}
	if _, _, err := e.client.Pipeline(ctx, "acme/web", sha1, PipelinePath, 10); err == nil || !strings.Contains(err.Error(), "the limit is 10") {
		t.Errorf("too large: %v", err)
	}
	queries := len(e.gh.queries)
	for _, bad := range [][2]string{{"abc", PipelinePath}, {sha1, "../secret"}, {sha1, "/etc/passwd"}, {sha1, "a b"}} {
		if _, _, err := e.client.Pipeline(ctx, "acme/web", bad[0], bad[1], 64<<10); err == nil {
			t.Errorf("Pipeline(%q, %q) was sent", bad[0], bad[1])
		}
	}
	if len(e.gh.queries) != queries {
		t.Error("a refused input reached GitHub")
	}
}

func TestGraphQLURL(t *testing.T) {
	for base, want := range map[string]string{
		"":                               "https://api.github.com/graphql",
		"https://api.github.com/":        "https://api.github.com/graphql",
		"https://ghe.example.com/api/v3": "https://ghe.example.com/api/graphql",
	} {
		c := &Client{App: &App{BaseURL: base}}
		if got := c.graphqlURL(); got != want {
			t.Errorf("base %q: %s, want %s", base, got, want)
		}
	}
}

func TestParsePrivateKey(t *testing.T) {
	k := testKey()
	pkcs1 := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)})
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	pkcs8 := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	for name, data := range map[string][]byte{"PKCS #1": pkcs1, "PKCS #8": pkcs8} {
		got, err := ParsePrivateKey(data)
		if err != nil || !got.Equal(k) {
			t.Errorf("%s: %v", name, err)
		}
	}
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ecDER, _ := x509.MarshalPKCS8PrivateKey(ec)
	for name, data := range map[string][]byte{
		"EC key":    pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecDER}),
		"no PEM":    []byte("not a key"),
		"wrong PEM": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{1}}),
	} {
		if _, err := ParsePrivateKey(data); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

// TestQueriesMatchGitHubSchema validates every document this package sends
// against GitHub's public schema with a real GraphQL parser, and checks the
// validator itself refuses a wrong field.
func TestQueriesMatchGitHubSchema(t *testing.T) {
	for name, q := range map[string]string{"heads (3)": headsQuery(3), "heads (100)": headsQuery(HeadsBatch), "more": moreQuery, "pipeline": pipelineQuery} {
		t.Run(name, func(t *testing.T) { validate(t, q) })
	}
	s, err := githubSchema()
	if err != nil {
		t.Fatal(err)
	}
	wrong := strings.Replace(pipelineQuery, "isTruncated", "isTrunkated", 1)
	if _, errs := gqlparser.LoadQuery(s, wrong); len(errs) == 0 {
		t.Fatal("the validator accepted a field GitHub does not have")
	}
}

// TestHeadsQueryCost computes the heads query's cost and node count the way
// GitHub's "Rate limits and query limits for the GraphQL API" describes:
// every connection asks first (or last) items; requests are the connections
// to fulfil, multiplied by their parents' sizes; points are requests / 100,
// at least 1; nodes are all items asked, at most 500,000.
func TestHeadsQueryCost(t *testing.T) {
	doc := validate(t, headsQuery(HeadsBatch))
	requests, nodes := cost(doc)
	points := int(math.Max(1, math.Round(float64(requests)/100)))
	if points != PointsPerBatch {
		t.Errorf("a batch of %d costs %d points (%d requests), the constant says %d", HeadsBatch, points, requests, PointsPerBatch)
	}
	if nodes > 500_000 || nodes != HeadsBatch*(HeadsPage+HeadsTags+HeadsPage) {
		t.Errorf("a batch asks for %d nodes", nodes)
	}
	if poll.GraphQLBatch != HeadsBatch || poll.GraphQLPointsPerBatch != PointsPerBatch {
		t.Errorf("poll plans with %d repositories at %d points, the query is %d at %d", poll.GraphQLBatch, poll.GraphQLPointsPerBatch, HeadsBatch, PointsPerBatch)
	}
}

func cost(doc *ast.QueryDocument) (requests, nodes int) {
	var walk func(set ast.SelectionSet, parent int)
	walk = func(set ast.SelectionSet, parent int) {
		for _, sel := range set {
			switch s := sel.(type) {
			case *ast.Field:
				size := 0
				for _, a := range s.Arguments {
					if a.Name == "first" || a.Name == "last" {
						fmt.Sscan(a.Value.Raw, &size)
					}
				}
				if size > 0 {
					requests += parent
					nodes += parent * size
					walk(s.SelectionSet, parent*size)
				} else {
					walk(s.SelectionSet, parent)
				}
			case *ast.FragmentSpread:
				walk(s.Definition.SelectionSet, parent)
			case *ast.InlineFragment:
				walk(s.SelectionSet, parent)
			}
		}
	}
	walk(doc.Operations[0].SelectionSet, 1)
	return requests, nodes
}
