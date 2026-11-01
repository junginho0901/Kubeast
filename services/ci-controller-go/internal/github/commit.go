package github

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// PipelinePath is where an app repository keeps its pipeline.
const PipelinePath = ".kubeast/pipeline.yaml"

// File is what Pipeline found at a commit.
type File struct {
	// CommitFound: the commit is in the repository. A signal naming a
	// commit GitHub does not have is not built.
	CommitFound bool
	// Found: the path is a file at that commit. Not found means the
	// repository has no pipeline file and gets the default pipeline.
	Found bool
	Data  []byte
}

const pipelineQuery = `query Pipeline($owner: String!, $name: String!, $oid: GitObjectID!, $expr: String!) {
  repository(owner: $owner, name: $name) {
    commit: object(oid: $oid) { __typename ... on Commit { oid } }
    file: object(expression: $expr) { __typename ... on Blob { byteSize isBinary isTruncated text } }
  }
` + rateLimitField + "}\n"

var (
	shaRe  = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
	pathRe = regexp.MustCompile(`^[A-Za-z0-9_./-]{1,255}$`)
)

// Pipeline reads, in one query, whether sha is a commit of repo and the
// file at path in it, refusing a file larger than max bytes, binary, or
// cut short by GitHub. This is the truth a webhook's signal is checked
// against before a build.
func (c *Client) Pipeline(ctx context.Context, repo, sha, path string, max int) (File, RateLimit, error) {
	var rl RateLimit
	owner, name, err := splitRepo(repo)
	if err != nil {
		return File{}, rl, err
	}
	if !shaRe.MatchString(sha) {
		return File{}, rl, fmt.Errorf("github: %q is not a full commit hash", sha)
	}
	if !pathRe.MatchString(path) || strings.Contains(path, "..") || strings.HasPrefix(path, "/") {
		return File{}, rl, fmt.Errorf("github: path %q", path)
	}
	vars := map[string]any{"owner": owner, "name": name, "oid": sha, "expr": sha + ":" + path}
	var data struct {
		Repository *struct {
			Commit *struct {
				Typename string `json:"__typename"`
				OID      string `json:"oid"`
			} `json:"commit"`
			File *struct {
				Typename    string  `json:"__typename"`
				ByteSize    int     `json:"byteSize"`
				IsBinary    bool    `json:"isBinary"`
				IsTruncated bool    `json:"isTruncated"`
				Text        *string `json:"text"`
			} `json:"file"`
		} `json:"repository"`
		RateLimit RateLimit `json:"rateLimit"`
	}
	errs, err := c.query(ctx, "pipeline "+repo, pipelineQuery, vars, &data)
	if err != nil {
		return File{}, rl, err
	}
	rl = data.RateLimit
	r := data.Repository
	if r == nil {
		if msg, ok := pathErrors(errs)["repository"]; ok && !notFound(msg) {
			return File{}, rl, fmt.Errorf("github: pipeline %s: %s", repo, msg)
		}
		return File{}, rl, ErrRepoNotFound
	}
	var f File
	f.CommitFound = r.Commit != nil && r.Commit.Typename == "Commit" && r.Commit.OID == sha
	if !f.CommitFound || r.File == nil {
		return f, rl, nil
	}
	switch {
	case r.File.Typename != "Blob":
		return f, rl, fmt.Errorf("github: %s at %s is a %s, not a file", path, sha[:12], r.File.Typename)
	case r.File.ByteSize > max:
		return f, rl, fmt.Errorf("github: %s at %s is %d bytes, the limit is %d", path, sha[:12], r.File.ByteSize, max)
	case r.File.IsBinary || r.File.Text == nil:
		return f, rl, fmt.Errorf("github: %s at %s is not text", path, sha[:12])
	case r.File.IsTruncated:
		return f, rl, fmt.Errorf("github: %s at %s came back cut short", path, sha[:12])
	}
	f.Found = true
	f.Data = []byte(*r.File.Text)
	return f, rl, nil
}
