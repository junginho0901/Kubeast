package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/auditchain"
	"github.com/junginho0901/kubeast/services/auth-service-go/internal/config"
	"github.com/junginho0901/kubeast/services/pkg/auth"
)

// chainStore is a three-row intact chain with no anchors.
type chainStore struct{ rows []auditchain.Row }

func newChainStore() *chainStore {
	s := &chainStore{}
	prev := auditchain.Genesis
	for i := int64(1); i <= 3; i++ {
		canon := "row"
		h := auditchain.RowHash(prev, canon)
		s.rows = append(s.rows, auditchain.Row{Seq: i, ID: 100 + i, Prev: prev, Hash: h, Canon: canon})
		prev = h
	}
	return s
}

func (s *chainStore) SealBatch(context.Context, int) (int, auditchain.Head, error) {
	return 0, auditchain.Head{Seq: 3, Hash: s.rows[2].Hash}, nil
}
func (s *chainStore) Head(context.Context) (auditchain.Head, error) {
	return auditchain.Head{Seq: 3, Hash: s.rows[2].Hash}, nil
}
func (s *chainStore) Bounds(context.Context) (int64, int64, int64, error) { return 1, 3, 0, nil }
func (s *chainStore) Rows(_ context.Context, from, to int64, _ int) ([]auditchain.Row, error) {
	var out []auditchain.Row
	for _, r := range s.rows {
		if r.Seq >= from && r.Seq <= to {
			out = append(out, r)
		}
	}
	return out, nil
}
func (s *chainStore) LastAnchor(context.Context) (*auditchain.Anchor, error) { return nil, nil }
func (s *chainStore) AnchorsIn(context.Context, int64, int64) ([]auditchain.Anchor, error) {
	return nil, nil
}
func (s *chainStore) InsertAnchor(context.Context, auditchain.Anchor) (int64, error) { return 1, nil }
func (s *chainStore) ReviewHashesBetween(context.Context, time.Time, time.Time) ([]auditchain.ReviewHash, error) {
	return nil, nil
}
func (s *chainStore) ReviewHashes(context.Context, []string) (map[string][]byte, error) {
	return map[string][]byte{}, nil
}

func integrityHandler(enabled bool, store auditchain.Store) *AuthHandler {
	h := &AuthHandler{auditStore: &memAuditStore{}, cfg: config.Config{AuditIntegrity: config.AuditIntegrityConfig{Enabled: enabled, SealSeconds: 10, AnchorHours: 24}}}
	if store != nil {
		h.SetAuditChain(&AuditChain{Store: store, Verifier: auditchain.Verifier{Store: store}})
	}
	return h
}

func TestAuditIntegrityGuards(t *testing.T) {
	read := auth.PermissionMatrix{"*": {"admin.audit.read"}}
	// Off → status says so, verify and anchor are 404.
	h := integrityHandler(false, nil)
	w := httptest.NewRecorder()
	h.AuditIntegrityStatus(w, reviewRequest(http.MethodGet, "/auth/admin/audit/integrity", read))
	var st auditIntegrityStatus
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if w.Code != http.StatusOK || st.Enabled {
		t.Fatalf("status with the feature off = %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	h.AdminAuditVerify(w, reviewRequest(http.MethodPost, "/auth/admin/audit/integrity/verify", read))
	if w.Code != http.StatusNotFound {
		t.Errorf("verify with the feature off: status = %d, want 404", w.Code)
	}
	// On, but no anchor sink → anchor now is 404; without permission → 403.
	h = integrityHandler(true, newChainStore())
	w = httptest.NewRecorder()
	h.AdminAuditAnchor(w, reviewRequest(http.MethodPost, "/auth/admin/audit/integrity/anchor", auth.PermissionMatrix{"*": {"admin.audit.export"}}))
	if w.Code != http.StatusNotFound {
		t.Errorf("anchor without a sink: status = %d, want 404", w.Code)
	}
	for name, call := range map[string]func(http.ResponseWriter, *http.Request){"status": h.AuditIntegrityStatus, "verify": h.AdminAuditVerify, "anchor": h.AdminAuditAnchor} {
		w := httptest.NewRecorder()
		call(w, reviewRequest(http.MethodPost, "/auth/admin/audit/integrity", auth.PermissionMatrix{"*": {"admin.users.read"}}))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s without the audit permission: status = %d, want 403", name, w.Code)
		}
	}
}

func TestAuditIntegrityStatusAndVerify(t *testing.T) {
	read := auth.PermissionMatrix{"*": {"admin.audit.read"}}
	h := integrityHandler(true, newChainStore())
	w := httptest.NewRecorder()
	h.AuditIntegrityStatus(w, reviewRequest(http.MethodGet, "/auth/admin/audit/integrity", read))
	var st auditIntegrityStatus
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if !st.Enabled || st.OldestSeq != 1 || st.SealedThroughSeq != 3 || st.UnsealedRows != 0 || st.LastAnchor != nil || st.SealSeconds != 10 || st.AnchorHours != 0 {
		t.Fatalf("status = %+v", st)
	}
	// Default range (no body) verifies the whole chain and is audited.
	w = httptest.NewRecorder()
	h.AdminAuditVerify(w, reviewRequest(http.MethodPost, "/auth/admin/audit/integrity/verify", read))
	var rep auditchain.Report
	if err := json.Unmarshal(w.Body.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || !rep.OK || rep.FromSeq != 1 || rep.ToSeq != 3 || rep.Rows != 3 {
		t.Fatalf("verify = %d %+v", w.Code, rep)
	}
	recs := h.auditStore.(*memAuditStore).written
	if len(recs) != 1 || recs[0].Action != "admin.audit.verify" || !strings.Contains(string(recs[0].After), `"ok":true`) {
		t.Fatalf("audit records = %+v", recs)
	}
	// An explicit range too large → 413 and a failure record.
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/auth/admin/audit/integrity/verify", strings.NewReader(`{"from_seq":1,"to_seq":999999}`))
	req = req.WithContext(auth.WithPayload(req.Context(), auth.TokenPayload{UserID: "u1", Email: "admin@example.com", Perms: read}))
	h.AdminAuditVerify(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large: status = %d %s", w.Code, w.Body.String())
	}
	if recs = h.auditStore.(*memAuditStore).written; len(recs) != 2 || recs[1].Result != "failure" {
		t.Fatalf("failure record = %+v", recs)
	}
}
