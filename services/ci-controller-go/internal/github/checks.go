package github

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"
)

// CheckRun is a build's result as GitHub shows it on a commit and its pull
// request: a check run of the app ("Create a check run" / "Update a check
// run" in the REST API, which needs the Checks write permission).
type CheckRun struct {
	// Name is the check's name on GitHub, the same for every build of a
	// pipeline so a new build's run replaces the old one in the list.
	Name    string
	HeadSHA string
	// ExternalID is Kubeast's build ID; DetailsURL its page in Kubeast.
	ExternalID string
	DetailsURL string
	// Status is queued, in_progress or completed (GitHub Actions alone may
	// set waiting, pending or requested).
	Status string
	// Conclusion is required with completed: success, failure, cancelled,
	// timed_out, neutral, skipped or action_required (stale is GitHub's).
	Conclusion  string
	StartedAt   time.Time
	CompletedAt time.Time
	// Title and Summary are the output GitHub shows; Text the details.
	// Summary and Text are cut to MaxCheckText with a note that the full
	// log is in Kubeast.
	Title   string
	Summary string
	Text    string
}

// Check run statuses and conclusions this package sends.
const (
	StatusQueued     = "queued"
	StatusInProgress = "in_progress"
	StatusCompleted  = "completed"
)

var conclusions = map[string]bool{
	"success": true, "failure": true, "cancelled": true, "timed_out": true,
	"neutral": true, "skipped": true, "action_required": true,
}

// MaxCheckText is GitHub's limit on a check run's summary and text
// (65535 characters). Text is cut on a byte count, which is never more
// characters than that.
const MaxCheckText = 65535

const cutNote = "\n\n… (cut here; the full log is in Kubeast)"

var checkNameRe = regexp.MustCompile(`^[^\x00-\x1f]{1,255}$`)

func (r CheckRun) validate(update bool) error {
	switch {
	case !update && !checkNameRe.MatchString(r.Name):
		return fmt.Errorf("github: check run name %q", r.Name)
	case !update && !shaRe.MatchString(r.HeadSHA):
		return fmt.Errorf("github: check run commit %q is not a full hash", r.HeadSHA)
	}
	switch r.Status {
	case StatusQueued, StatusInProgress:
		if r.Conclusion != "" || !r.CompletedAt.IsZero() {
			return fmt.Errorf("github: a %s check run has no conclusion or completion time", r.Status)
		}
	case StatusCompleted:
		if !conclusions[r.Conclusion] {
			return fmt.Errorf("github: a completed check run needs a conclusion, not %q", r.Conclusion)
		}
	default:
		return fmt.Errorf("github: check run status %q (queued, in_progress or completed)", r.Status)
	}
	if r.Title == "" && (r.Summary != "" || r.Text != "") {
		return fmt.Errorf("github: check run output needs a title")
	}
	return nil
}

// cut shortens s to MaxCheckText bytes on a character boundary, ending
// with a note when it cut.
func cut(s string) string {
	if len(s) <= MaxCheckText {
		return s
	}
	n := MaxCheckText - len(cutNote)
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n] + cutNote
}

func (r CheckRun) body(update bool, now time.Time) map[string]any {
	b := map[string]any{"status": r.Status}
	if !update {
		b["name"] = r.Name
		b["head_sha"] = r.HeadSHA
	}
	if r.ExternalID != "" {
		b["external_id"] = r.ExternalID
	}
	if r.DetailsURL != "" {
		b["details_url"] = r.DetailsURL
	}
	if !r.StartedAt.IsZero() {
		b["started_at"] = r.StartedAt.UTC().Format(time.RFC3339)
	}
	if r.Status == StatusCompleted {
		b["conclusion"] = r.Conclusion
		completed := r.CompletedAt
		if completed.IsZero() {
			completed = now
		}
		b["completed_at"] = completed.UTC().Format(time.RFC3339)
	}
	if r.Title != "" {
		out := map[string]any{"title": r.Title, "summary": cut(r.Summary)}
		if r.Text != "" {
			out["text"] = cut(r.Text)
		}
		b["output"] = out
	}
	return b
}

// CreateCheckRun creates the run and returns its ID for later updates.
func (c *Client) CreateCheckRun(ctx context.Context, repo string, r CheckRun) (int64, error) {
	if _, _, err := splitRepo(repo); err != nil {
		return 0, err
	}
	if err := r.validate(false); err != nil {
		return 0, err
	}
	var out struct {
		ID int64 `json:"id"`
	}
	if err := c.rest(ctx, http.MethodPost, "/repos/"+repo+"/check-runs", r.body(false, c.App.now()), http.StatusCreated, &out); err != nil {
		return 0, err
	}
	if out.ID <= 0 {
		return 0, fmt.Errorf("github: check run for %s: an answer without an ID", repo)
	}
	return out.ID, nil
}

// UpdateCheckRun moves the run on: in progress, then completed with its
// conclusion and output.
func (c *Client) UpdateCheckRun(ctx context.Context, repo string, id int64, r CheckRun) error {
	if _, _, err := splitRepo(repo); err != nil {
		return err
	}
	if id <= 0 {
		return fmt.Errorf("github: check run ID %d", id)
	}
	if err := r.validate(true); err != nil {
		return err
	}
	return c.rest(ctx, http.MethodPatch, "/repos/"+repo+"/check-runs/"+strconv.FormatInt(id, 10), r.body(true, c.App.now()), http.StatusOK, nil)
}

// rest sends one REST call as the installation. A 401 drops the cached
// token and is tried once more with a new one.
func (c *Client) rest(ctx context.Context, method, path string, body any, want int, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	op := method + " " + path
	for attempt := 0; ; attempt++ {
		tok, err := c.App.InstallationToken(ctx, c.Installation)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, method, c.App.baseURL()+path, bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("Authorization", "Bearer "+tok.Value)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-GitHub-Api-Version", APIVersion)
		req.Header.Set("User-Agent", UserAgent)
		resp, err := c.App.client().Do(req)
		if err != nil {
			return fmt.Errorf("github: %s: %w", op, err)
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("github: %s: %w", op, readErr)
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 {
			c.App.Forget(c.Installation)
			continue
		}
		if resp.StatusCode != want {
			return apiError(resp, raw, op)
		}
		if out != nil {
			if err := json.Unmarshal(raw, out); err != nil {
				return fmt.Errorf("github: %s: %w", op, err)
			}
		}
		return nil
	}
}

// Build outcomes the controller reports, and the conclusion each becomes.
const (
	OutcomeSucceeded = "succeeded"
	OutcomeFailed    = "failed"
	OutcomeCancelled = "cancelled" // a person, or a newer push to the branch
	OutcomeTimedOut  = "timed-out" // the pipeline's timeout (the Job's deadline)
	OutcomeReplaced  = "replaced"  // waited, then a newer push replaced it
	OutcomeNeedsOK   = "needs-approval"
)

// Conclusion maps a build outcome to a check run conclusion; ok is false
// for an outcome it does not know.
func Conclusion(outcome string) (conclusion string, ok bool) {
	switch outcome {
	case OutcomeSucceeded:
		return "success", true
	case OutcomeFailed:
		return "failure", true
	case OutcomeCancelled:
		return "cancelled", true
	case OutcomeTimedOut:
		return "timed_out", true
	case OutcomeReplaced:
		return "skipped", true
	case OutcomeNeedsOK:
		// A pull request from a fork waits for a maintainer (decision 36).
		return "action_required", true
	}
	return "", false
}
