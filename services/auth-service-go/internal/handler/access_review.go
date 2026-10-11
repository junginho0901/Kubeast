package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/accessreview"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/model"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/repository"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/auth"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Access review (Admin → Access review): the report of who has what
// (accounts, per-cluster grants, API keys, temporary grants since the last
// review, roles), its CSV, and the sign-off that records a review was done.
// Permissions admin.review.read / .export / .signoff; every call is audited.

const (
	reviewNoteMax      = 2000
	reviewHistoryLimit = 100
	reviewRequestsMax  = 5000
)

type accessReviewConfigResponse struct {
	Enabled      bool `json:"enabled"`
	DormantDays  int  `json:"dormant_days"`
	IntervalDays int  `json:"interval_days"`
}

// AccessReviewConfig handles GET /auth/access-review/config: whether the
// feature is on and its windows, so the console shows or hides the page.
func (h *AuthHandler) AccessReviewConfig(w http.ResponseWriter, r *http.Request) {
	cfg := h.cfg.AccessReview
	response.JSON(w, http.StatusOK, accessReviewConfigResponse{Enabled: cfg.Enabled, DormantDays: cfg.DormantDays, IntervalDays: cfg.IntervalDays})
}

func (h *AuthHandler) accessReviewSettings() accessreview.Settings {
	return accessreview.Settings{DormantDays: h.cfg.AccessReview.DormantDays, IntervalDays: h.cfg.AccessReview.IntervalDays}
}

// requireAccessReview answers 404 when the feature is off and 403 without
// the permission; otherwise returns the caller.
func (h *AuthHandler) requireAccessReview(w http.ResponseWriter, r *http.Request, permission string) (auth.TokenPayload, bool) {
	if !h.cfg.AccessReview.Enabled {
		response.Error(w, http.StatusNotFound, "Access review is disabled")
		return auth.TokenPayload{}, false
	}
	return requirePerm(h.auditStore, w, r, permission)
}

// touchLastLogin records a successful sign-in on the account (best effort).
func (h *AuthHandler) touchLastLogin(r *http.Request, user *model.User) {
	if h.repo == nil || user == nil {
		return
	}
	if err := h.repo.TouchLastLogin(r.Context(), user.ID, time.Now().UTC()); err != nil {
		slog.Warn("last_login_at not updated", "user", user.Email, "error", err)
	}
}

func (h *AuthHandler) reviewAudit(r *http.Request, payload auth.TokenPayload, action, targetID string, after map[string]any, err error) {
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = action
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "access-review"
	rec.TargetID = targetID
	if after != nil {
		rec.After = audit.MustJSON(after)
	}
	if err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = err.Error()
	}
	if _, werr := h.auditStore.Write(r.Context(), rec); werr != nil {
		slog.Error("access review audit write failed", "action", action, "error", werr)
	}
}

// lastReviewSummary loads the newest sign-off for the report header.
func (h *AuthHandler) lastReviewSummary(r *http.Request) (*accessreview.ReviewSummary, error) {
	last, err := h.repo.LastAccessReview(r.Context())
	if err != nil || last == nil {
		return nil, err
	}
	return &accessreview.ReviewSummary{ID: last.ID, ReviewedByEmail: last.ReviewedByEmail, ReviewedAt: last.ReviewedAt, Note: last.Note}, nil
}

// buildAccessReview reads everything and assembles the report as of now.
func (h *AuthHandler) buildAccessReview(r *http.Request, now time.Time, since *time.Time) (*accessreview.Report, error) {
	ctx := r.Context()
	last, err := h.lastReviewSummary(r)
	if err != nil {
		return nil, fmt.Errorf("last review: %w", err)
	}
	settings := h.accessReviewSettings()
	from := accessreview.DefaultSince(now, settings, last)
	if since != nil {
		from = *since
	}
	in := accessreview.Input{LastReview: last}
	if in.Users, err = h.repo.ListUsersForReview(ctx); err != nil {
		return nil, fmt.Errorf("users: %w", err)
	}
	if in.Grants, err = h.repo.ListClusterGrantsForReview(ctx); err != nil {
		return nil, fmt.Errorf("cluster grants: %w", err)
	}
	if in.Keys, err = h.repo.ListAPIKeysForReview(ctx); err != nil {
		return nil, fmt.Errorf("api keys: %w", err)
	}
	if in.Requests, err = h.repo.ListAccessRequestsSince(ctx, from, reviewRequestsMax); err != nil {
		return nil, fmt.Errorf("access requests: %w", err)
	}
	if in.Roles, err = h.repo.ListRoles(ctx); err != nil {
		return nil, fmt.Errorf("roles: %w", err)
	}
	if in.UsersByRole, err = h.repo.CountUsersByRole(ctx); err != nil {
		return nil, fmt.Errorf("users by role: %w", err)
	}
	if in.GrantsByRole, err = h.repo.CountClusterGrantsByRole(ctx); err != nil {
		return nil, fmt.Errorf("grants by role: %w", err)
	}
	return accessreview.Build(now, settings, from, in), nil
}

func parseSince(r *http.Request) (*time.Time, error) {
	raw := strings.TrimSpace(r.URL.Query().Get("since"))
	if raw == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil, fmt.Errorf("since must be RFC 3339")
	}
	return &t, nil
}

// AdminAccessReview handles GET /auth/admin/access-review?since=: the report.
func (h *AuthHandler) AdminAccessReview(w http.ResponseWriter, r *http.Request) {
	payload, ok := h.requireAccessReview(w, r, "admin.review.read")
	if !ok {
		return
	}
	since, err := parseSince(r)
	if err != nil {
		response.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	rep, err := h.buildAccessReview(r, time.Now().UTC(), since)
	if err != nil {
		h.reviewAudit(r, payload, "admin.review.read", "", nil, err)
		response.InternalError(w, r, err)
		return
	}
	h.reviewAudit(r, payload, "admin.review.read", "", map[string]any{"counts": rep.Counts(), "since": rep.Since}, nil)
	response.JSON(w, http.StatusOK, rep)
}

// AdminAccessReviewExport handles GET /auth/admin/access-review/export?section=&since=&review_id=:
// one section as CSV, of the live report or of a signed-off snapshot.
func (h *AuthHandler) AdminAccessReviewExport(w http.ResponseWriter, r *http.Request) {
	payload, ok := h.requireAccessReview(w, r, "admin.review.export")
	if !ok {
		return
	}
	section := strings.TrimSpace(r.URL.Query().Get("section"))
	if !accessReviewSectionKnown(section) {
		response.Error(w, http.StatusBadRequest, "section must be one of "+strings.Join(accessReviewSections, ", "))
		return
	}
	reviewID := strings.TrimSpace(r.URL.Query().Get("review_id"))
	var rep *accessreview.Report
	var err error
	if reviewID != "" {
		rep, err = h.snapshotReport(r, reviewID)
	} else {
		var since *time.Time
		if since, err = parseSince(r); err != nil {
			response.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		rep, err = h.buildAccessReview(r, time.Now().UTC(), since)
	}
	if err != nil {
		if errors.Is(err, repository.ErrAccessReviewNotFound) {
			response.Error(w, http.StatusNotFound, "Access review not found")
			return
		}
		h.reviewAudit(r, payload, "admin.review.export", reviewID, map[string]any{"section": section}, err)
		response.InternalError(w, r, err)
		return
	}
	header, rows := accessReviewCSV(rep, section)
	h.reviewAudit(r, payload, "admin.review.export", reviewID, map[string]any{"section": section, "rows": len(rows), "review_id": reviewID}, nil)

	stamp := rep.GeneratedAt.UTC().Format("20060102-150405")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", "access-review-"+section+"-"+stamp+".csv"))
	w.WriteHeader(http.StatusOK)
	writeCSV(w, header, rows)
}

func (h *AuthHandler) snapshotReport(r *http.Request, id string) (*accessreview.Report, error) {
	rev, err := h.repo.GetAccessReview(r.Context(), id)
	if err != nil {
		return nil, err
	}
	var rep accessreview.Report
	if err := json.Unmarshal(rev.Snapshot, &rep); err != nil {
		return nil, fmt.Errorf("snapshot %s: %w", id, err)
	}
	return &rep, nil
}

type signoffRequest struct {
	Note string `json:"note"`
}

// AdminAccessReviewSignoff handles POST /auth/admin/access-review/signoff
// {note}: stores the report as it stands with who signed and when.
func (h *AuthHandler) AdminAccessReviewSignoff(w http.ResponseWriter, r *http.Request) {
	payload, ok := h.requireAccessReview(w, r, "admin.review.signoff")
	if !ok {
		return
	}
	var req signoffRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			response.Error(w, http.StatusBadRequest, "Invalid JSON body")
			return
		}
	}
	note := strings.TrimSpace(req.Note)
	if len(note) > reviewNoteMax {
		response.Error(w, http.StatusBadRequest, fmt.Sprintf("note must be at most %d characters", reviewNoteMax))
		return
	}
	now := time.Now().UTC()
	rep, err := h.buildAccessReview(r, now, nil)
	if err != nil {
		h.reviewAudit(r, payload, "admin.review.signoff", "", nil, err)
		response.InternalError(w, r, err)
		return
	}
	snapshot, err := json.Marshal(rep)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	userID := payload.UserID
	rev := &repository.AccessReview{ID: uuid.NewString(), ReviewedBy: &userID, ReviewedByEmail: payload.Email, ReviewedAt: now, Note: note,
		Counts: audit.MustJSON(rep.Counts()), Snapshot: snapshot}
	if err := h.repo.CreateAccessReview(r.Context(), rev); err != nil {
		h.reviewAudit(r, payload, "admin.review.signoff", rev.ID, map[string]any{"counts": rep.Counts(), "note": note}, err)
		response.InternalError(w, r, err)
		return
	}
	h.reviewAudit(r, payload, "admin.review.signoff", rev.ID, map[string]any{"counts": rep.Counts(), "note": note}, nil)
	rev.Snapshot = nil
	response.JSON(w, http.StatusCreated, rev)
}

// AdminAccessReviewHistory handles GET /auth/admin/access-review/history:
// past sign-offs, newest first, without snapshots.
func (h *AuthHandler) AdminAccessReviewHistory(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAccessReview(w, r, "admin.review.read"); !ok {
		return
	}
	list, err := h.repo.ListAccessReviews(r.Context(), reviewHistoryLimit)
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	response.JSON(w, http.StatusOK, list)
}

// AdminAccessReviewSnapshot handles GET /auth/admin/access-review/history/{id}:
// one sign-off with the report as it stood.
func (h *AuthHandler) AdminAccessReviewSnapshot(w http.ResponseWriter, r *http.Request) {
	payload, ok := h.requireAccessReview(w, r, "admin.review.read")
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	rev, err := h.repo.GetAccessReview(r.Context(), id)
	if err != nil {
		if errors.Is(err, repository.ErrAccessReviewNotFound) {
			response.Error(w, http.StatusNotFound, "Access review not found")
			return
		}
		response.InternalError(w, r, err)
		return
	}
	h.reviewAudit(r, payload, "admin.review.read", id, map[string]any{"snapshot": true, "reviewed_at": rev.ReviewedAt}, nil)
	response.JSON(w, http.StatusOK, rev)
}
