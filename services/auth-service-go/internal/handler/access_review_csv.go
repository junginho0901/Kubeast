package handler

import (
	"encoding/csv"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/junginho0901/kubeast/services/auth-service-go/internal/accessreview"
)

// The CSV sections of the access review, one file each, columns as the
// report rows carry them (reviewers open these in a spreadsheet).
var accessReviewSections = []string{"users", "cluster_roles", "api_keys", "access_requests", "roles"}

func accessReviewSectionKnown(s string) bool {
	for _, k := range accessReviewSections {
		if s == k {
			return true
		}
	}
	return false
}

// accessReviewCSV renders one section: the header row and the data rows.
func accessReviewCSV(rep *accessreview.Report, section string) ([]string, [][]string) {
	var rows [][]string
	switch section {
	case "users":
		for _, u := range rep.Users {
			rows = append(rows, csvCells(u.Email, u.Name, u.Team, u.AuthSource, u.GlobalRole, csvTime(&u.CreatedAt), csvTime(u.LastLoginAt), csvTime(u.LockedUntil),
				strconv.Itoa(u.ClusterRoles), strconv.Itoa(u.APIKeys), strconv.Itoa(u.TemporaryGrants), strings.Join(u.Flags, ";")))
		}
		return []string{"email", "name", "team", "auth_source", "global_role", "created_at", "last_login_at", "locked_until", "cluster_roles", "api_keys", "temporary_grants", "flags"}, rows
	case "cluster_roles":
		for _, g := range rep.ClusterRoles {
			rows = append(rows, csvCells(g.UserEmail, g.Cluster, g.Role, g.GrantedVia, csvTime(g.ExpiresAt), g.RestoreRole, strings.Join(g.Flags, ";")))
		}
		return []string{"user_email", "cluster", "role", "granted_via", "expires_at", "restore_role", "flags"}, rows
	case "api_keys":
		for _, k := range rep.APIKeys {
			rows = append(rows, csvCells(k.OwnerEmail, k.Name, k.KeyPrefix, strings.Join(k.Clusters, ";"), k.RoleCeiling, csvTime(&k.CreatedAt), csvTime(&k.ExpiresAt),
				csvTime(k.LastUsedAt), k.LastUsedIP, strings.Join(k.Flags, ";")))
		}
		return []string{"owner_email", "name", "key_prefix", "clusters", "role_ceiling", "created_at", "expires_at", "last_used_at", "last_used_ip", "flags"}, rows
	case "access_requests":
		for _, a := range rep.AccessRequests {
			rows = append(rows, csvCells(a.RequesterEmail, a.Cluster, a.Role, strconv.Itoa(a.DurationMinutes), a.Reason, a.Status, csvTime(&a.CreatedAt),
				a.DecidedByEmail, csvTime(a.DecidedAt), a.DecisionNote, csvTime(a.ExpiresAt), csvTime(a.EndedAt), a.EndReason))
		}
		return []string{"requester_email", "cluster", "role", "duration_minutes", "reason", "status", "created_at", "decided_by_email", "decided_at", "decision_note", "expires_at", "ended_at", "end_reason"}, rows
	case "roles":
		for _, r := range rep.Roles {
			rows = append(rows, csvCells(r.Name, strconv.FormatBool(r.IsSystem), r.Description, strings.Join(r.Permissions, ";"), strconv.Itoa(r.Users), strconv.Itoa(r.ClusterBindings), strings.Join(r.Flags, ";")))
		}
		return []string{"name", "is_system", "description", "permissions", "users", "cluster_bindings", "flags"}, rows
	}
	return nil, nil
}

func csvTime(t *time.Time) string {
	if t == nil || t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// writeCSV writes a spreadsheet-friendly file: UTF-8 BOM, CRLF (RFC 4180).
func writeCSV(w io.Writer, header []string, rows [][]string) {
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	cw := csv.NewWriter(w)
	cw.UseCRLF = true
	_ = cw.Write(header)
	for _, row := range rows {
		_ = cw.Write(row)
	}
	cw.Flush()
}
