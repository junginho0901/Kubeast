// Access review — the admin's periodic "who has what" report
// (/auth/admin/access-review), its CSV sections and the sign-off that
// records a review was done. Off when auth.accessReview.enabled is false
// (the config endpoint says so and the menu item hides).

import { client } from './client'
import { totalHeader } from './access_requests'

export interface AccessReviewConfig {
  enabled: boolean
  dormant_days: number
  interval_days: number
}

export type AccessReviewSection = 'users' | 'cluster_roles' | 'api_keys' | 'access_requests' | 'roles'
export const ACCESS_REVIEW_SECTIONS: AccessReviewSection[] = ['users', 'cluster_roles', 'api_keys', 'access_requests', 'roles']

export interface AccessReviewUserRow {
  email: string
  name: string
  team: string
  auth_source: string
  global_role: string
  created_at: string
  last_login_at: string | null
  locked_until?: string
  dormant_locked_at?: string
  cluster_roles: number
  api_keys: number
  temporary_grants: number
  flags: string[]
}

export interface AccessReviewClusterRoleRow {
  user_email: string
  cluster: string
  role: string
  namespaces?: string[]
  granted_via: string
  expires_at?: string
  restore_role?: string
  flags: string[]
}

export interface AccessReviewAPIKeyRow {
  owner_email: string
  name: string
  key_prefix: string
  clusters: string[]
  role_ceiling: string
  created_at: string
  expires_at: string
  last_used_at: string | null
  last_used_ip?: string
  flags: string[]
}

export interface AccessReviewRequestRow {
  requester_email: string
  cluster: string
  role: string
  duration_minutes: number
  reason: string
  status: string
  created_at: string
  decided_by_email?: string
  decided_at?: string
  decision_note?: string
  expires_at?: string
  ended_at?: string
  end_reason?: string
}

export interface AccessReviewRoleRow {
  name: string
  is_system: boolean
  description: string
  permissions: string[]
  users: number
  cluster_bindings: number
  flags: string[]
}

export interface AccessReviewSummary {
  users: number
  // accounts whose global role carries "*" or an admin.* permission (the card "with admin permissions")
  global_admins: number
  // of those, the "*" ones (global admins); absent in reports signed off before it was counted
  full_admins?: number
  dormant: number
  never_logged_in: number
  locked: number
  dormant_locked: number
  cluster_grants: number
  temporary_grants: number
  api_keys_active: number
  api_keys_expiring: number
  api_keys_unused: number
  access_requests: number
}

export interface AccessReviewSignoff {
  id: string
  reviewed_by?: string
  reviewed_by_email: string
  reviewed_at: string
  note: string
  counts: Record<string, number>
  snapshot?: AccessReviewReport
}

export interface AccessReviewReport {
  generated_at: string
  // the dormant lock's settings are absent in reports signed off before they were kept
  settings: { dormant_days: number; interval_days: number; lock_enabled?: boolean; lock_days?: number; lock_exempt_admins?: boolean }
  since: string
  last_review: { id: string; reviewed_by_email: string; reviewed_at: string; note: string } | null
  next_due_at: string | null
  overdue: boolean
  summary: AccessReviewSummary
  users: AccessReviewUserRow[]
  cluster_roles: AccessReviewClusterRoleRow[]
  api_keys: AccessReviewAPIKeyRow[]
  access_requests: AccessReviewRequestRow[]
  // every request since `since`; access_requests holds the newest of them (absent in older sign-offs)
  access_requests_total?: number
  roles: AccessReviewRoleRow[]
}

export const accessReviewApi = {
  getAccessReviewConfig: async (): Promise<AccessReviewConfig> => {
    const { data } = await client.get('/auth/access-review/config')
    return { enabled: !!data?.enabled, dormant_days: Number(data?.dormant_days) || 0, interval_days: Number(data?.interval_days) || 0 }
  },

  getAccessReview: async (since?: string): Promise<AccessReviewReport> => {
    const { data } = await client.get('/auth/admin/access-review', { params: { since } })
    return data
  },

  // Taken with the session cookie (hooks/useDownload), so a refusal says why on the page; the server names the file.
  accessReviewExportUrl: (section: AccessReviewSection, opts: { since?: string; reviewId?: string } = {}): string => {
    const params = new URLSearchParams({ section })
    if (opts.since) params.set('since', opts.since)
    if (opts.reviewId) params.set('review_id', opts.reviewId)
    return `/api/v1/auth/admin/access-review/export?${params.toString()}`
  },

  signoffAccessReview: async (note: string): Promise<AccessReviewSignoff> => {
    const { data } = await client.post('/auth/admin/access-review/signoff', { note })
    return data
  },

  // One page of the sign-offs, newest first, and how many are kept.
  listAccessReviews: async (page: { limit: number; offset: number }): Promise<{ items: AccessReviewSignoff[]; total: number }> => {
    const { data, headers } = await client.get('/auth/admin/access-review/history', { params: page })
    if (!Array.isArray(data)) throw new Error('Invalid access review history response')
    return { items: data, total: totalHeader(headers) }
  },

  getAccessReviewSnapshot: async (id: string): Promise<AccessReviewSignoff> => {
    const { data } = await client.get(`/auth/admin/access-review/history/${encodeURIComponent(id)}`)
    return data
  },
}
