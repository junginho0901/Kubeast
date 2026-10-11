package handler

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/auditchain"
	"github.com/junginho0901/kubeast/services/pkg/audit"
	"github.com/junginho0901/kubeast/services/pkg/response"
)

// Audit log integrity (internal/auditchain): the chain status the console
// shows, a verification run and "anchor now". The sealer and the anchorer
// run from main.go.

// AuditChain is what the handler needs from the chain. Anchorer is nil when
// no anchor sink is configured.
type AuditChain struct {
	Store    auditchain.Store
	Verifier auditchain.Verifier
	Anchorer *auditchain.Anchorer
}

// SetAuditChain gives the handler the chain (nil = feature off).
func (h *AuthHandler) SetAuditChain(c *AuditChain) { h.chain = c }

type auditIntegrityAnchor struct {
	ID         int64     `json:"id"`
	CreatedAt  time.Time `json:"created_at"`
	FromSeq    int64     `json:"from_seq"`
	ToSeq      int64     `json:"to_seq"`
	Rows       int64     `json:"rows"`
	AnchorHash string    `json:"anchor_hash"`
	Sink       string    `json:"sink"`
	ObjectKey  string    `json:"object_key"`
	Actor      string    `json:"actor"`
}

func anchorView(a auditchain.Anchor) *auditIntegrityAnchor {
	return &auditIntegrityAnchor{ID: a.ID, CreatedAt: a.CreatedAt, FromSeq: a.FromSeq, ToSeq: a.ToSeq, Rows: a.Rows,
		AnchorHash: hex.EncodeToString(a.AnchorHash), Sink: a.Sink, ObjectKey: a.ObjectKey, Actor: a.Actor}
}

type auditIntegrityStatus struct {
	Enabled          bool                  `json:"enabled"`
	SealSeconds      int                   `json:"seal_seconds,omitempty"`
	AnchorSink       string                `json:"anchor_sink,omitempty"`
	AnchorHours      int                   `json:"anchor_hours,omitempty"`
	OldestSeq        int64                 `json:"oldest_seq"`
	SealedThroughSeq int64                 `json:"sealed_through_seq"`
	UnsealedRows     int64                 `json:"unsealed_rows"`
	LastAnchor       *auditIntegrityAnchor `json:"last_anchor"`
}

func (h *AuthHandler) chainOn() bool { return h.cfg.AuditIntegrity.Enabled && h.chain != nil }

// AuditIntegrityStatus handles GET /auth/admin/audit/integrity
// (admin.audit.read): {enabled:false} when the feature is off.
func (h *AuthHandler) AuditIntegrityStatus(w http.ResponseWriter, r *http.Request) {
	if _, ok := requirePerm(h.auditStore, w, r, "admin.audit.read"); !ok {
		return
	}
	if !h.chainOn() {
		response.JSON(w, http.StatusOK, auditIntegrityStatus{Enabled: false})
		return
	}
	oldest, newest, unsealed, err := h.chain.Store.Bounds(r.Context())
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	last, err := h.chain.Store.LastAnchor(r.Context())
	if err != nil {
		response.InternalError(w, r, err)
		return
	}
	cfg := h.cfg.AuditIntegrity
	st := auditIntegrityStatus{Enabled: true, SealSeconds: cfg.SealSeconds, AnchorSink: cfg.AnchorSink, AnchorHours: cfg.AnchorHours,
		OldestSeq: oldest, SealedThroughSeq: newest, UnsealedRows: unsealed}
	if cfg.AnchorSink == "" {
		st.AnchorHours = 0
	}
	if last != nil {
		st.LastAnchor = anchorView(*last)
	}
	response.JSON(w, http.StatusOK, st)
}

type auditVerifyRequest struct {
	FromSeq int64 `json:"from_seq"`
	ToSeq   int64 `json:"to_seq"`
	Anchors bool  `json:"anchors"`
}

// AdminAuditVerify handles POST /auth/admin/audit/integrity/verify
// (admin.audit.read): recomputes the range (default: since the last anchor)
// and compares the anchors in it, recorded as admin.audit.verify.
func (h *AuthHandler) AdminAuditVerify(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.audit.read")
	if !ok {
		return
	}
	if !h.chainOn() {
		response.Error(w, http.StatusNotFound, "Audit log integrity is disabled")
		return
	}
	var req auditVerifyRequest
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			response.Error(w, http.StatusBadRequest, "Invalid JSON body")
			return
		}
	}
	from, to := req.FromSeq, req.ToSeq
	if from <= 0 || to <= 0 {
		var err error
		if from, to, err = auditchain.DefaultRange(r.Context(), h.chain.Store); err != nil {
			response.InternalError(w, r, err)
			return
		}
	}
	rep, err := h.chain.Verifier.Verify(r.Context(), from, to, req.Anchors)
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = "admin.audit.verify"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "audit-chain"
	rec.After = audit.MustJSON(map[string]any{"from_seq": rep.FromSeq, "to_seq": rep.ToSeq, "rows": rep.Rows, "ok": rep.OK,
		"first_bad_seq": rep.FirstBadSeq, "reason": rep.Reason, "anchors": len(rep.Anchors), "objects": req.Anchors})
	if err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = err.Error()
		_, _ = h.auditStore.Write(r.Context(), rec)
		if errors.Is(err, auditchain.ErrTooMany) {
			response.Error(w, http.StatusRequestEntityTooLarge, err.Error())
			return
		}
		response.InternalError(w, r, err)
		return
	}
	_, _ = h.auditStore.Write(r.Context(), rec)
	response.JSON(w, http.StatusOK, rep)
}

// AdminAuditAnchor handles POST /auth/admin/audit/integrity/anchor
// (admin.audit.export): writes one digest now, recorded as admin.audit.anchor.
func (h *AuthHandler) AdminAuditAnchor(w http.ResponseWriter, r *http.Request) {
	payload, ok := requirePerm(h.auditStore, w, r, "admin.audit.export")
	if !ok {
		return
	}
	if !h.chainOn() || h.chain.Anchorer == nil {
		response.Error(w, http.StatusNotFound, "Audit log anchoring is disabled (no anchor sink)")
		return
	}
	a, err := h.chain.Anchorer.AnchorOnce(r.Context(), payload.Email)
	rec := audit.FromHTTPRequest(r)
	rec.Service = audit.ServiceAdmin
	rec.Action = "admin.audit.anchor"
	rec.ActorUserID = payload.UserID
	rec.ActorEmail = payload.Email
	rec.TargetType = "audit-chain"
	rec.TargetID = h.cfg.AuditIntegrity.AnchorSink
	if err != nil {
		rec.Result = audit.ResultFailure
		rec.Error = err.Error()
		_, _ = h.auditStore.Write(r.Context(), rec)
		response.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	rec.After = audit.MustJSON(auditchain.AnchorSummary(a))
	_, _ = h.auditStore.Write(r.Context(), rec)
	response.JSON(w, http.StatusOK, anchorView(a))
}
