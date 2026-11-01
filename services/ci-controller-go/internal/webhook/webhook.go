// Package webhook receives GitHub webhook deliveries and turns the ones
// that matter into signals: which repository, which ref, which commit. It
// follows GitHub's "Best practices for using webhooks" and "Validating
// webhook deliveries": the X-Hub-Signature-256 HMAC is required and compared
// in constant time, only push, pull_request and ping are taken (and only
// the pull request actions that change the code), a delivery ID is taken
// once, and the answer comes at once while the work is queued.
//
// A payload is never trusted for more than the signal: the controller reads
// the commit and the pipeline file again from GitHub with its own app
// credentials before it builds anything.
package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Event kinds a Verifier passes on.
const (
	KindPush        = "push"
	KindPullRequest = "pull_request"
)

// Event is the signal one delivery carries.
type Event struct {
	Delivery string `json:"delivery"`
	Kind     string `json:"kind"`
	// Action is a pull request's action: opened, reopened or synchronize.
	Action       string `json:"action,omitempty"`
	Installation int64  `json:"installation,omitempty"`
	RepoID       int64  `json:"repoId"`
	Repo         string `json:"repo"`
	// Ref is what pipeline triggers match: the pushed refs/heads/… or
	// refs/tags/…, or a pull request's target branch as refs/heads/….
	Ref string `json:"ref"`
	// SHA is the pushed commit, or the pull request's head commit.
	SHA string `json:"sha"`
	// HeadRef is refs/pull/<number>/head for a pull request.
	HeadRef string `json:"headRef,omitempty"`
	Number  int    `json:"number,omitempty"`
	// Fork marks a pull request whose head is in another repository (or
	// in one that was deleted): its build runs only after a maintainer
	// approves, and without secrets.
	Fork bool `json:"fork,omitempty"`
	// Sender is the account GitHub names, for the audit record only.
	Sender string `json:"sender,omitempty"`
}

// Outcome is what a delivery came to.
type Outcome int

const (
	// Accepted: a signal to queue.
	Accepted Outcome = iota
	// Ignored: valid, signed and nothing to build (an event or action
	// outside the list, a deleted branch, a ping).
	Ignored
	// Rejected: refused; Reason says why.
	Rejected
)

// Result of checking one delivery.
type Result struct {
	Outcome Outcome
	Event   Event
	// Reason is a short code for Ignored and Rejected deliveries, for the
	// answer and the audit record: bad-signature, no-signature, malformed,
	// event, action, deleted, ping.
	Reason string
}

// Verifier checks deliveries against the webhook secrets. More than one
// secret is allowed so a secret can be rotated: the new one is added, the
// GitHub App switched to it, then the old one removed.
type Verifier struct {
	secrets [][]byte
}

// MinSecretLen is the shortest secret accepted. GitHub suggests "a random
// string of text with high entropy"; 32 bytes is what `openssl rand -hex 16`
// gives.
const MinSecretLen = 32

// NewVerifier refuses to work without a secret: a receiver that skips the
// check when no secret is set lets anyone start builds (Tekton Triggers'
// GitHub interceptor passes everything when secretRef is left out).
func NewVerifier(secrets ...[]byte) (*Verifier, error) {
	if len(secrets) == 0 {
		return nil, errors.New("webhook: no secret; deliveries cannot be checked")
	}
	v := &Verifier{}
	for i, s := range secrets {
		if len(s) < MinSecretLen {
			return nil, fmt.Errorf("webhook: secret %d is %d bytes, at least %d", i+1, len(s), MinSecretLen)
		}
		v.secrets = append(v.secrets, append([]byte(nil), s...))
	}
	return v, nil
}

// String never shows the secrets.
func (v *Verifier) String() string {
	return fmt.Sprintf("webhook.Verifier(%d secrets)", len(v.secrets))
}

// SignatureValid reports whether header, an X-Hub-Signature-256 value
// ("sha256=" and 64 hex digits), is body's HMAC-SHA256 under one of the
// secrets. Every secret is tried with hmac.Equal, which compares in
// constant time.
func (v *Verifier) SignatureValid(header string, body []byte) bool {
	hexSig, ok := strings.CutPrefix(header, "sha256=")
	if !ok || len(hexSig) != sha256.Size*2 {
		return false
	}
	sig, err := hex.DecodeString(hexSig)
	if err != nil {
		return false
	}
	valid := false
	for _, s := range v.secrets {
		mac := hmac.New(sha256.New, s)
		mac.Write(body)
		if hmac.Equal(sig, mac.Sum(nil)) {
			valid = true
		}
	}
	return valid
}

// Check reads one delivery whose body was read whole: event is the
// X-GitHub-Event header, delivery X-GitHub-Delivery and signature
// X-Hub-Signature-256. The signature is checked before anything in the
// body is read.
func (v *Verifier) Check(event, delivery, signature string, body []byte) Result {
	if signature == "" {
		return Result{Outcome: Rejected, Reason: "no-signature"}
	}
	if !v.SignatureValid(signature, body) {
		return Result{Outcome: Rejected, Reason: "bad-signature"}
	}
	if !deliveryRe.MatchString(delivery) || event == "" {
		return Result{Outcome: Rejected, Reason: "malformed"}
	}
	switch event {
	case "ping":
		return Result{Outcome: Ignored, Reason: "ping"}
	case KindPush:
		return parsePush(delivery, body)
	case KindPullRequest:
		return parsePullRequest(delivery, body)
	default:
		return Result{Outcome: Ignored, Reason: "event"}
	}
}

// BuildActions are the pull request actions that change the code to build.
var BuildActions = map[string]bool{"opened": true, "reopened": true, "synchronize": true}

type repository struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
}

type common struct {
	Installation *struct {
		ID int64 `json:"id"`
	} `json:"installation"`
	Repository *repository `json:"repository"`
	Sender     *struct {
		Login string `json:"login"`
	} `json:"sender"`
}

func (c common) event(delivery, kind string) (Event, bool) {
	if c.Repository == nil || c.Repository.ID <= 0 || !repoRe.MatchString(c.Repository.FullName) {
		return Event{}, false
	}
	e := Event{Delivery: delivery, Kind: kind, RepoID: c.Repository.ID, Repo: c.Repository.FullName}
	if c.Installation != nil {
		e.Installation = c.Installation.ID
	}
	if c.Sender != nil {
		e.Sender = c.Sender.Login
	}
	return e, true
}

func parsePush(delivery string, body []byte) Result {
	var p struct {
		common
		Ref     string `json:"ref"`
		After   string `json:"after"`
		Deleted bool   `json:"deleted"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return Result{Outcome: Rejected, Reason: "malformed"}
	}
	e, ok := p.event(delivery, KindPush)
	if !ok || !pushRefRe.MatchString(p.Ref) || !shaRe.MatchString(p.After) {
		return Result{Outcome: Rejected, Reason: "malformed"}
	}
	if p.Deleted || strings.Trim(p.After, "0") == "" {
		return Result{Outcome: Ignored, Reason: "deleted"}
	}
	e.Ref, e.SHA = p.Ref, p.After
	return Result{Outcome: Accepted, Event: e}
}

func parsePullRequest(delivery string, body []byte) Result {
	var p struct {
		common
		Action      string `json:"action"`
		Number      int    `json:"number"`
		PullRequest *struct {
			Head struct {
				SHA  string      `json:"sha"`
				Repo *repository `json:"repo"`
			} `json:"head"`
			Base struct {
				Ref  string      `json:"ref"`
				Repo *repository `json:"repo"`
			} `json:"base"`
		} `json:"pull_request"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		return Result{Outcome: Rejected, Reason: "malformed"}
	}
	if !BuildActions[p.Action] {
		return Result{Outcome: Ignored, Reason: "action"}
	}
	e, ok := p.event(delivery, KindPullRequest)
	pr := p.PullRequest
	if !ok || pr == nil || p.Number <= 0 || !shaRe.MatchString(pr.Head.SHA) || !branchRe.MatchString(pr.Base.Ref) {
		return Result{Outcome: Rejected, Reason: "malformed"}
	}
	e.Action = p.Action
	e.Number = p.Number
	e.Ref = "refs/heads/" + pr.Base.Ref
	e.SHA = pr.Head.SHA
	e.HeadRef = "refs/pull/" + strconv.Itoa(p.Number) + "/head"
	// A head repository GitHub no longer shows (deleted fork) counts as a
	// fork, so the safe side is taken.
	e.Fork = pr.Head.Repo == nil || pr.Head.Repo.ID != e.RepoID
	return Result{Outcome: Accepted, Event: e}
}

var (
	// deliveryRe: GitHub sends a GUID; anything short of letters, digits
	// and hyphens is taken as malformed.
	deliveryRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
	repoRe     = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`)
	shaRe      = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
	pushRefRe  = regexp.MustCompile(`^refs/(heads|tags)/[^\s]{1,255}$`)
	branchRe   = regexp.MustCompile(`^[^\s]{1,255}$`)
)
