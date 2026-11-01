package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Client asks GitHub's GraphQL API on behalf of one installation.
type Client struct {
	App          *App
	Installation int64
	// GraphQLURL, when empty, is derived from the app's BaseURL:
	// https://api.github.com/graphql, or https://<host>/api/graphql on
	// GitHub Enterprise Server.
	GraphQLURL string
}

// RateLimit is the GraphQL rateLimit object of an answer.
type RateLimit struct {
	Cost      int       `json:"cost"`
	Limit     int       `json:"limit"`
	Remaining int       `json:"remaining"`
	Used      int       `json:"used"`
	ResetAt   time.Time `json:"resetAt"`
}

// MaxResponse bounds one GraphQL answer read into memory.
const MaxResponse = 32 << 20

func (c *Client) graphqlURL() string {
	if c.GraphQLURL != "" {
		return c.GraphQLURL
	}
	base := c.App.baseURL()
	if strings.HasSuffix(base, "/api/v3") {
		return strings.TrimSuffix(base, "/v3") + "/graphql"
	}
	return base + "/graphql"
}

type gqlError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Path    []any  `json:"path"`
}

// query posts one GraphQL document. A 401 drops the cached token and is
// tried once more with a new one.
func (c *Client) query(ctx context.Context, op, document string, vars map[string]any, data any) ([]gqlError, error) {
	body, err := json.Marshal(map[string]any{"query": document, "variables": vars})
	if err != nil {
		return nil, err
	}
	for attempt := 0; ; attempt++ {
		tok, err := c.App.InstallationToken(ctx, c.Installation)
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.graphqlURL(), bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+tok.Value)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", UserAgent)
		resp, err := c.App.client().Do(req)
		if err != nil {
			return nil, fmt.Errorf("github: %s: %w", op, err)
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, MaxResponse+1))
		resp.Body.Close()
		if readErr != nil {
			return nil, fmt.Errorf("github: %s: %w", op, readErr)
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			c.App.Forget(c.Installation)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			return nil, apiError(resp, raw, op)
		}
		if len(raw) > MaxResponse {
			return nil, fmt.Errorf("github: %s: answer larger than %d bytes", op, MaxResponse)
		}
		var out struct {
			Data   json.RawMessage `json:"data"`
			Errors []gqlError      `json:"errors"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("github: %s: %w", op, err)
		}
		var global []string
		for _, e := range out.Errors {
			if len(e.Path) == 0 {
				global = append(global, e.Type+" "+e.Message)
			}
		}
		if len(global) > 0 || len(out.Data) == 0 || string(out.Data) == "null" {
			if len(global) == 0 {
				global = []string{"no data"}
			}
			return nil, fmt.Errorf("github: %s: %s", op, strings.Join(global, "; "))
		}
		if err := json.Unmarshal(out.Data, data); err != nil {
			return nil, fmt.Errorf("github: %s: %w", op, err)
		}
		return out.Errors, nil
	}
}

// RepoHeads is what polling compares between two polls of a repository.
type RepoHeads struct {
	Repo     string
	RepoID   int64
	Archived bool
	// Missing: GitHub has no such repository for this installation (renamed
	// away, deleted, or not granted to the app).
	Missing bool
	// Branches and Tags map a name to its commit. Tags are the newest
	// HeadsTags by commit date.
	Branches map[string]string
	Tags     map[string]string
	// PullRequests are the open ones.
	PullRequests []PullRequest
	// Truncated: more branches or pull requests than MaxPages pages.
	Truncated bool
}

// PullRequest is an open pull request's head.
type PullRequest struct {
	Number  int
	HeadSHA string
	Base    string
	// Fork: the head is in another repository.
	Fork  bool
	Draft bool
}

// Sizes of the heads query. With HeadsBatch repositories a query asks for
// about 22,000 nodes (GitHub's limit is 500,000) and costs PointsPerBatch
// points: one request per repository for each of its three connections,
// divided by 100.
const (
	HeadsBatch     = 100
	HeadsPage      = 100
	HeadsTags      = 20
	PointsPerBatch = 3
	// MaxPages bounds the follow-up pages of one repository's branches or
	// pull requests (10,000 of each).
	MaxPages = 100
)

const headsFragment = `
fragment heads on Repository {
  databaseId
  nameWithOwner
  isArchived
  branches: refs(refPrefix: "refs/heads/", first: 100) {
    nodes { name target { oid } }
    pageInfo { hasNextPage endCursor }
  }
  tags: refs(refPrefix: "refs/tags/", first: 20, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
    nodes { name target { oid ... on Tag { target { oid } } } }
  }
  pullRequests(states: OPEN, first: 100) {
    nodes { number headRefOid baseRefName isCrossRepository isDraft }
    pageInfo { hasNextPage endCursor }
  }
}
`

const rateLimitField = `  rateLimit { cost limit remaining used resetAt }
`

// headsQuery is one batch's document: repositories are aliases r0…rN and
// their owners and names are variables, never text in the query.
func headsQuery(n int) string {
	var b strings.Builder
	b.WriteString("query Heads(")
	for i := 0; i < n; i++ {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "$o%d: String!, $n%d: String!", i, i)
	}
	b.WriteString(") {\n")
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "  r%d: repository(owner: $o%d, name: $n%d) { ...heads }\n", i, i, i)
	}
	b.WriteString(rateLimitField)
	b.WriteString("}\n")
	b.WriteString(headsFragment)
	return b.String()
}

const moreQuery = `query More($owner: String!, $name: String!, $branches: String, $prs: String, $wantBranches: Boolean!, $wantPRs: Boolean!) {
  repository(owner: $owner, name: $name) {
    branches: refs(refPrefix: "refs/heads/", first: 100, after: $branches) @include(if: $wantBranches) {
      nodes { name target { oid } }
      pageInfo { hasNextPage endCursor }
    }
    pullRequests(states: OPEN, first: 100, after: $prs) @include(if: $wantPRs) {
      nodes { number headRefOid baseRefName isCrossRepository isDraft }
      pageInfo { hasNextPage endCursor }
    }
  }
` + rateLimitField + "}\n"

type refNode struct {
	Name   string `json:"name"`
	Target *struct {
		OID    string `json:"oid"`
		Target *struct {
			OID string `json:"oid"`
		} `json:"target"`
	} `json:"target"`
}

// commit is the commit a ref points at: an annotated tag's target, or the
// object itself.
func (n refNode) commit() string {
	if n.Target == nil {
		return ""
	}
	if n.Target.Target != nil && n.Target.Target.OID != "" {
		return n.Target.Target.OID
	}
	return n.Target.OID
}

type pageInfo struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

type refConn struct {
	Nodes    []refNode `json:"nodes"`
	PageInfo pageInfo  `json:"pageInfo"`
}

type prConn struct {
	Nodes []struct {
		Number            int    `json:"number"`
		HeadRefOid        string `json:"headRefOid"`
		BaseRefName       string `json:"baseRefName"`
		IsCrossRepository bool   `json:"isCrossRepository"`
		IsDraft           bool   `json:"isDraft"`
	} `json:"nodes"`
	PageInfo pageInfo `json:"pageInfo"`
}

type repoData struct {
	DatabaseID    int64    `json:"databaseId"`
	NameWithOwner string   `json:"nameWithOwner"`
	IsArchived    bool     `json:"isArchived"`
	Branches      *refConn `json:"branches"`
	Tags          *refConn `json:"tags"`
	PullRequests  *prConn  `json:"pullRequests"`
}

var repoNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)

func splitRepo(repo string) (string, string, error) {
	if !repoNameRe.MatchString(repo) {
		return "", "", fmt.Errorf("github: %q is not owner/name", repo)
	}
	owner, name, _ := strings.Cut(repo, "/")
	return owner, name, nil
}

// Heads reads the branches, newest tags and open pull requests of repos,
// HeadsBatch to a query, following further pages of a repository that has
// more. The rate limit returned is the last answer's.
func (c *Client) Heads(ctx context.Context, repos []string) (map[string]RepoHeads, RateLimit, error) {
	out := make(map[string]RepoHeads, len(repos))
	var rl RateLimit
	for start := 0; start < len(repos); start += HeadsBatch {
		batch := repos[start:min(start+HeadsBatch, len(repos))]
		vars := map[string]any{}
		for i, repo := range batch {
			owner, name, err := splitRepo(repo)
			if err != nil {
				return nil, rl, err
			}
			vars[fmt.Sprintf("o%d", i)] = owner
			vars[fmt.Sprintf("n%d", i)] = name
		}
		data := map[string]json.RawMessage{}
		errs, err := c.query(ctx, "heads", headsQuery(len(batch)), vars, &data)
		if err != nil {
			return nil, rl, err
		}
		if raw, ok := data["rateLimit"]; ok {
			_ = json.Unmarshal(raw, &rl)
		}
		failed := pathErrors(errs)
		for i, repo := range batch {
			alias := fmt.Sprintf("r%d", i)
			var rd *repoData
			if raw, ok := data[alias]; ok {
				if err := json.Unmarshal(raw, &rd); err != nil {
					return nil, rl, fmt.Errorf("github: heads %s: %w", repo, err)
				}
			}
			if rd == nil {
				if msg, ok := failed[alias]; ok && !notFound(msg) {
					return nil, rl, fmt.Errorf("github: heads %s: %s", repo, msg)
				}
				out[repo] = RepoHeads{Repo: repo, Missing: true}
				continue
			}
			h, err := c.complete(ctx, repo, rd, &rl)
			if err != nil {
				return nil, rl, err
			}
			out[repo] = h
		}
	}
	return out, rl, nil
}

// complete turns one repository's answer into RepoHeads, asking for the
// further pages it announces.
func (c *Client) complete(ctx context.Context, repo string, rd *repoData, rl *RateLimit) (RepoHeads, error) {
	h := RepoHeads{Repo: repo, RepoID: rd.DatabaseID, Archived: rd.IsArchived, Branches: map[string]string{}, Tags: map[string]string{}}
	addRefs := func(m map[string]string, conn *refConn) {
		if conn == nil {
			return
		}
		for _, n := range conn.Nodes {
			if sha := n.commit(); sha != "" {
				m[n.Name] = sha
			}
		}
	}
	addPRs := func(conn *prConn) {
		if conn == nil {
			return
		}
		for _, p := range conn.Nodes {
			h.PullRequests = append(h.PullRequests, PullRequest{Number: p.Number, HeadSHA: p.HeadRefOid, Base: p.BaseRefName, Fork: p.IsCrossRepository, Draft: p.IsDraft})
		}
	}
	addRefs(h.Branches, rd.Branches)
	addRefs(h.Tags, rd.Tags)
	addPRs(rd.PullRequests)

	branchCursor, prCursor := "", ""
	if rd.Branches != nil && rd.Branches.PageInfo.HasNextPage {
		branchCursor = rd.Branches.PageInfo.EndCursor
	}
	if rd.PullRequests != nil && rd.PullRequests.PageInfo.HasNextPage {
		prCursor = rd.PullRequests.PageInfo.EndCursor
	}
	owner, name, _ := strings.Cut(repo, "/")
	for page := 0; branchCursor != "" || prCursor != ""; page++ {
		if page >= maxPages {
			h.Truncated = true
			break
		}
		vars := map[string]any{
			"owner": owner, "name": name,
			"branches": nullable(branchCursor), "prs": nullable(prCursor),
			"wantBranches": branchCursor != "", "wantPRs": prCursor != "",
		}
		var data struct {
			Repository *repoData `json:"repository"`
			RateLimit  RateLimit `json:"rateLimit"`
		}
		if _, err := c.query(ctx, "heads "+repo+" (more)", moreQuery, vars, &data); err != nil {
			return h, err
		}
		*rl = data.RateLimit
		if data.Repository == nil {
			return h, fmt.Errorf("github: heads %s (more): the repository is gone", repo)
		}
		branchCursor, prCursor = "", ""
		if conn := data.Repository.Branches; conn != nil {
			addRefs(h.Branches, conn)
			if conn.PageInfo.HasNextPage {
				branchCursor = conn.PageInfo.EndCursor
			}
		}
		if conn := data.Repository.PullRequests; conn != nil {
			addPRs(conn)
			if conn.PageInfo.HasNextPage {
				prCursor = conn.PageInfo.EndCursor
			}
		}
	}
	return h, nil
}

// maxPages is MaxPages; tests lower it.
var maxPages = MaxPages

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// pathErrors maps a top-level alias to its error message.
func pathErrors(errs []gqlError) map[string]string {
	out := map[string]string{}
	for _, e := range errs {
		if len(e.Path) > 0 {
			if alias, ok := e.Path[0].(string); ok {
				out[alias] = e.Type + " " + e.Message
			}
		}
	}
	return out
}

func notFound(msg string) bool { return strings.HasPrefix(msg, "NOT_FOUND ") }

// ErrRepoNotFound: the repository is not visible to the installation.
var ErrRepoNotFound = errors.New("github: repository not found for this installation")
