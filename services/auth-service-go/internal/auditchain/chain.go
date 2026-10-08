// Package auditchain makes the audit log tamper-evident.
//
// A sealer chains auth_audit_logs rows in sealing order: every row gets a
// position (chain_seq), the hash of the row before it (prev_hash) and its own
// hash, row_hash = sha256(prev_hash || 0x1e || canonical row). Changing or
// deleting a sealed row breaks the chain from that row on. An anchorer writes
// the chain head to an S3 sink as a digest now and then and remembers it in
// audit_anchors, so a rewritten database no longer matches the copy outside
// it. A verifier recomputes a range and compares it with the anchors. The
// write path is untouched: services keep inserting rows and the sealer picks
// them up (docs/audit-log-plan.md §4).
package auditchain

import (
	"crypto/sha256"
	"errors"
	"time"
)

// CanonSQL is the canonical form of a row as a PostgreSQL expression, so the
// sealer, the verifier and a psql one-liner hash the same bytes:
//
//	encode(sha256(prev_hash || '\x1e'::bytea || convert_to(<CanonSQL>, 'UTF8')), 'hex') = encode(row_hash, 'hex')
const CanonSQL = `concat_ws(E'\x1f', id, coalesce(service,''), action, coalesce(actor_user_id,''), coalesce(actor_email,''), coalesce(target_user_id,''), coalesce(target_email,''), coalesce(target_type,''), coalesce(target_id,''), coalesce(before::text,''), coalesce(after::text,''), coalesce(request_ip,''), coalesce(user_agent,''), coalesce(request_id,''), coalesce(path,''), coalesce(cluster,''), coalesce(namespace,''), result, coalesce(error,''), to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US'))`

const (
	// HashSize is the length of every hash in the chain (SHA-256).
	HashSize = sha256.Size
	// DefaultBatch is how many unsealed rows one sealing transaction takes.
	DefaultBatch = 1000
	sep          = 0x1e
)

// Genesis is the prev_hash of the first sealed row.
var Genesis = make([]byte, HashSize)

// ErrBusy is returned by SealBatch when another replica holds the sealing lock.
var ErrBusy = errors.New("auditchain: another replica is sealing")

// Unsealed is a row the sealer has not chained yet.
type Unsealed struct {
	ID    int64
	Canon string
}

// Sealed is what the sealer writes back for one row.
type Sealed struct {
	ID, Seq    int64
	Prev, Hash []byte
}

// Head is the end of the chain: Seq 0 and Genesis when nothing is sealed.
type Head struct {
	Seq  int64
	Hash []byte
}

// Row is a sealed row as the verifier reads it.
type Row struct {
	Seq, ID    int64
	Prev, Hash []byte
	Canon      string
}

// Anchor is one digest written to the anchor sink (table audit_anchors).
type Anchor struct {
	ID             int64     `json:"id"`
	CreatedAt      time.Time `json:"created_at"`
	FromSeq        int64     `json:"from_seq"`
	ToSeq          int64     `json:"to_seq"`
	Rows           int64     `json:"rows"`
	HeadHash       []byte    `json:"-"`
	PrevAnchorHash []byte    `json:"-"`
	AnchorHash     []byte    `json:"-"`
	Sink           string    `json:"sink"`
	ObjectKey      string    `json:"object_key"`
	Actor          string    `json:"actor"`
}

// ReviewHash is the hash of one access review sign-off's snapshot.
type ReviewHash struct {
	ID         string
	ReviewedAt time.Time
	Hash       []byte
}

// RowHash computes sha256(prev || 0x1e || canon).
func RowHash(prev []byte, canon string) []byte {
	h := sha256.New()
	h.Write(prev)
	h.Write([]byte{sep})
	h.Write([]byte(canon))
	return h.Sum(nil)
}

// sealRows chains rows onto head in the order given and returns the new head.
func sealRows(head Head, rows []Unsealed) ([]Sealed, Head) {
	prev := head.Hash
	if len(prev) != HashSize {
		prev = Genesis
	}
	seq := head.Seq
	out := make([]Sealed, 0, len(rows))
	for _, r := range rows {
		seq++
		h := RowHash(prev, r.Canon)
		out = append(out, Sealed{ID: r.ID, Seq: seq, Prev: prev, Hash: h})
		prev = h
	}
	return out, Head{Seq: seq, Hash: prev}
}
