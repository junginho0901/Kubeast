package github

import (
	"compress/gzip"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vektah/gqlparser/v2"
	"github.com/vektah/gqlparser/v2/ast"
)

// githubSchema is GitHub's public GraphQL schema for github.com, from
// github/docs at 2026-10-27 (testdata/SOURCES.txt).
var githubSchema = sync.OnceValues(func() (*ast.Schema, error) {
	f, err := os.Open("testdata/github-schema-20261027.graphql.gz")
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	sdl, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	s, gerr := gqlparser.LoadSchema(&ast.Source{Name: "github.graphql", Input: string(sdl)})
	if gerr != nil {
		return nil, gerr
	}
	return s, nil
})

// validate checks a query document against GitHub's schema with a real
// GraphQL parser and validator.
func validate(t testing.TB, query string) *ast.QueryDocument {
	t.Helper()
	s, err := githubSchema()
	if err != nil {
		t.Fatalf("loading GitHub's schema: %v", err)
	}
	doc, errs := gqlparser.LoadQuery(s, query)
	if len(errs) > 0 {
		t.Fatalf("the query does not validate against GitHub's schema: %v\n%s", errs, query)
	}
	return doc
}

type fakeRef struct {
	name, sha string
	annotated bool // a tag object pointing at sha
}

type fakePR struct {
	number int
	head   string
	base   string
	fork   bool
	draft  bool
}

type fakeRepo struct {
	id       int64
	archived bool
	branches []fakeRef
	tags     []fakeRef // newest first
	prs      []fakePR
	commits  map[string]bool
	// files[sha][path]: content; a value "<dir>" is a directory, "<binary>"
	// a binary file, "<truncated>" a text GitHub cut short.
	files map[string]map[string]string
}

// fakeGitHub answers the app token endpoint and the GraphQL queries this
// package makes, checking each the way GitHub would.
type fakeGitHub struct {
	t      *testing.T
	appID  string
	key    *rsa.PublicKey
	now    func() time.Time
	repos  map[string]*fakeRepo
	denied map[string]string // repo -> error type for a per-repository error other than NOT_FOUND

	mu          sync.Mutex
	tokens      map[string]int64 // token -> installation
	tokenCalls  int
	tokenBodies []string
	queries     []string // operation names in order
	documents   []string
	// fail answers the next requests with these statuses (and headers).
	fail []failure
}

type failure struct {
	status  int
	headers map[string]string
	message string
}

func (f *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("User-Agent") == "" {
		f.t.Errorf("%s without a User-Agent", r.URL.Path)
	}
	if len(f.fail) > 0 {
		fl := f.fail[0]
		f.fail = f.fail[1:]
		for k, v := range fl.headers {
			w.Header().Set(k, v)
		}
		w.WriteHeader(fl.status)
		fmt.Fprintf(w, `{"message":%q}`, fl.message)
		return
	}
	switch {
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/app/installations/") && strings.HasSuffix(r.URL.Path, "/access_tokens"):
		f.token(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/graphql":
		f.graphql(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeGitHub) token(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-GitHub-Api-Version") != APIVersion || r.Header.Get("Accept") != "application/vnd.github+json" {
		f.t.Errorf("token request headers: version %q, accept %q", r.Header.Get("X-GitHub-Api-Version"), r.Header.Get("Accept"))
	}
	jwt, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || f.checkJWT(jwt) != nil {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintf(w, `{"message":"A JSON web token could not be decoded: %v"}`, f.checkJWT(jwt))
		return
	}
	id, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/app/installations/"), "/access_tokens"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	body, _ := io.ReadAll(r.Body)
	f.tokenBodies = append(f.tokenBodies, string(body))
	f.tokenCalls++
	tok := fmt.Sprintf("ghs_test_%d_%d", id, f.tokenCalls)
	if f.tokens == nil {
		f.tokens = map[string]int64{}
	}
	f.tokens[tok] = id
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"token": tok, "expires_at": f.now().Add(time.Hour).UTC().Format(time.RFC3339)})
}

// checkJWT verifies the signature with the app's public key and the claims
// GitHub requires.
func (f *fakeGitHub) checkJWT(jwt string) error {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return fmt.Errorf("not three parts")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return err
	}
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(f.key, crypto.SHA256, sum[:], sig); err != nil {
		return err
	}
	var header struct{ Alg, Typ string }
	var claims struct {
		Iat, Exp int64
		Iss      string
	}
	h, _ := base64.RawURLEncoding.DecodeString(parts[0])
	c, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if json.Unmarshal(h, &header) != nil || json.Unmarshal(c, &claims) != nil {
		return fmt.Errorf("undecodable")
	}
	now := f.now().Unix()
	switch {
	case header.Alg != "RS256":
		return fmt.Errorf("alg %s", header.Alg)
	case claims.Iss != f.appID:
		return fmt.Errorf("iss %q", claims.Iss)
	case claims.Iat > now:
		return fmt.Errorf("issued in the future")
	case claims.Exp > now+600 || claims.Exp <= now:
		return fmt.Errorf("expiry %d s from now", claims.Exp-now)
	}
	return nil
}

func (f *fakeGitHub) graphql(w http.ResponseWriter, r *http.Request) {
	tok, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if _, ok := f.tokens[tok]; !ok {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"message":"Bad credentials"}`)
		return
	}
	var req struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		f.t.Errorf("graphql body: %v", err)
		return
	}
	doc := validate(f.t, req.Query)
	op := doc.Operations[0].Name
	f.queries = append(f.queries, op)
	f.documents = append(f.documents, req.Query)
	data := map[string]any{"rateLimit": map[string]any{"cost": 3, "limit": 5000, "remaining": 5000 - 3*len(f.queries), "used": 3 * len(f.queries), "resetAt": f.now().Add(time.Hour).UTC().Format(time.RFC3339)}}
	var errs []map[string]any
	switch op {
	case "Heads":
		for i := 0; ; i++ {
			owner, ok := req.Variables[fmt.Sprintf("o%d", i)].(string)
			if !ok {
				break
			}
			alias := fmt.Sprintf("r%d", i)
			name := req.Variables[fmt.Sprintf("n%d", i)].(string)
			repo, e := f.lookup(owner+"/"+name, alias)
			if e != nil {
				data[alias] = nil
				errs = append(errs, e)
				continue
			}
			data[alias] = f.repoJSON(owner+"/"+name, repo, "", "", true, true, true)
		}
	case "More":
		full := req.Variables["owner"].(string) + "/" + req.Variables["name"].(string)
		repo := f.repos[full]
		bc, _ := req.Variables["branches"].(string)
		pc, _ := req.Variables["prs"].(string)
		data["repository"] = f.repoJSON(full, repo, bc, pc, req.Variables["wantBranches"].(bool), false, req.Variables["wantPRs"].(bool))
	case "Pipeline":
		full := req.Variables["owner"].(string) + "/" + req.Variables["name"].(string)
		repo, e := f.lookup(full, "repository")
		if e != nil {
			data["repository"] = nil
			errs = append(errs, e)
			break
		}
		data["repository"] = f.pipelineJSON(repo, req.Variables["oid"].(string), req.Variables["expr"].(string))
	default:
		f.t.Errorf("unexpected operation %q", op)
	}
	json.NewEncoder(w).Encode(map[string]any{"data": data, "errors": errs})
}

func (f *fakeGitHub) lookup(full, alias string) (*fakeRepo, map[string]any) {
	if typ, ok := f.denied[full]; ok {
		return nil, map[string]any{"type": typ, "path": []string{alias}, "message": "Resource not accessible by integration"}
	}
	repo, ok := f.repos[full]
	if !ok {
		return nil, map[string]any{"type": "NOT_FOUND", "path": []string{alias}, "message": fmt.Sprintf("Could not resolve to a Repository with the name '%s'.", full)}
	}
	return repo, nil
}

// page cuts list at the cursor "<offset>", n at a time.
func page[T any](list []T, cursor string, n int) ([]T, map[string]any) {
	start := 0
	if cursor != "" {
		start, _ = strconv.Atoi(cursor)
	}
	end := min(start+n, len(list))
	if start > len(list) {
		start = len(list)
	}
	return list[start:end], map[string]any{"hasNextPage": end < len(list), "endCursor": strconv.Itoa(end)}
}

func refJSON(refs []fakeRef) []any {
	out := []any{}
	for _, r := range refs {
		target := map[string]any{"oid": r.sha}
		if r.annotated {
			target = map[string]any{"oid": "7a9" + r.sha[3:], "target": map[string]any{"oid": r.sha}}
		}
		out = append(out, map[string]any{"name": r.name, "target": target})
	}
	return out
}

func (f *fakeGitHub) repoJSON(full string, repo *fakeRepo, branchCursor, prCursor string, withBranches, withTags, withPRs bool) map[string]any {
	out := map[string]any{"databaseId": repo.id, "nameWithOwner": full, "isArchived": repo.archived}
	if withBranches {
		branches := append([]fakeRef(nil), repo.branches...)
		sort.Slice(branches, func(i, j int) bool { return branches[i].name < branches[j].name })
		nodes, info := page(branches, branchCursor, HeadsPage)
		out["branches"] = map[string]any{"nodes": refJSON(nodes), "pageInfo": info}
	}
	if withTags {
		nodes, _ := page(repo.tags, "", HeadsTags)
		out["tags"] = map[string]any{"nodes": refJSON(nodes)}
	}
	if withPRs {
		nodes, info := page(repo.prs, prCursor, HeadsPage)
		prs := []any{}
		for _, p := range nodes {
			prs = append(prs, map[string]any{"number": p.number, "headRefOid": p.head, "baseRefName": p.base, "isCrossRepository": p.fork, "isDraft": p.draft})
		}
		out["pullRequests"] = map[string]any{"nodes": prs, "pageInfo": info}
	}
	return out
}

func (f *fakeGitHub) pipelineJSON(repo *fakeRepo, oid, expr string) map[string]any {
	out := map[string]any{"commit": nil, "file": nil}
	if repo.commits[oid] {
		out["commit"] = map[string]any{"__typename": "Commit", "oid": oid}
	}
	sha, path, _ := strings.Cut(expr, ":")
	content, ok := repo.files[sha][path]
	if !ok || !repo.commits[sha] {
		return out
	}
	switch content {
	case "<dir>":
		out["file"] = map[string]any{"__typename": "Tree"}
	case "<binary>":
		out["file"] = map[string]any{"__typename": "Blob", "byteSize": 12, "isBinary": true, "isTruncated": false, "text": nil}
	case "<truncated>":
		out["file"] = map[string]any{"__typename": "Blob", "byteSize": 100, "isBinary": false, "isTruncated": true, "text": "cut"}
	default:
		out["file"] = map[string]any{"__typename": "Blob", "byteSize": len(content), "isBinary": false, "isTruncated": false, "text": content}
	}
	return out
}
