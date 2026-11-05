// Access requests — temporary per-cluster role grants. A user who already
// reaches a cluster asks for a higher role for a bounded time; an admin
// (admin.users.update, not the requester) approves or rejects. An approval
// revokes the requester's session, so they sign in again with the role; the
// grant ends on its own when the time passes.

import { client } from './client'

export interface AccessRequestsConfig {
  enabled: boolean
  max_hours: number
  roles: string[]
  /** Where a user with no cluster asks for one (chart auth.accessHelp); empty when unset */
  help_text: string
  help_url: string
}

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
export type AccessRequestEndReason = 'expired' | 'not_reviewed' | 'revoked' | 'superseded'

export interface AccessRequest {
  id: string
  user_id: string
  user_email: string
  user_name: string
  cluster_id: string
  cluster_name: string
  role: string
  duration_minutes: number
  reason: string
  status: AccessRequestStatus
  created_at: string
  decided_by?: string
  decided_by_email?: string
  decided_at?: string
  decision_note?: string
  expires_at?: string
  ended_at?: string
  end_reason?: AccessRequestEndReason
  // The temporary grant's namespaces; absent = the whole cluster.
  namespaces?: string[]
}

// One page of the admin list: the server's filter — one status or "decided" (every request no longer pending) —
// and search, and the count of every match.
export interface AccessRequestQuery {
  status?: AccessRequestStatus | 'decided'
  q?: string
  limit: number
  offset: number
}

export interface AccessRequestPage {
  items: AccessRequest[]
  total: number
}

// The count of every match a paged list answers next to its page (X-Kubeast-Total); an answer without it is an
// error, not a count of the rows that came.
export function totalHeader(headers: unknown): number {
  const raw = (headers as Record<string, unknown> | undefined)?.['x-kubeast-total']
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 0) throw new Error('The answer has no X-Kubeast-Total count')
  return n
}

export interface CreateAccessRequestInput {
  cluster_id: string
  role: string
  duration_minutes: number
  reason: string
  // Limit the temporary grant to these namespaces (required when the current grant is namespace-scoped).
  namespaces?: string[]
}

export const accessRequestsApi = {
  getAccessRequestsConfig: async (): Promise<AccessRequestsConfig> => {
    const { data } = await client.get('/auth/access-requests/config')
    const helpURL = String(data?.help_url || '')
    return {
      enabled: !!data?.enabled,
      max_hours: Number(data?.max_hours) || 0,
      roles: Array.isArray(data?.roles) ? data.roles : [],
      help_text: String(data?.help_text || ''),
      help_url: /^https?:\/\//i.test(helpURL) ? helpURL : '',
    }
  },

  createAccessRequest: async (input: CreateAccessRequestInput): Promise<AccessRequest> => {
    const { data } = await client.post('/auth/access-requests', input)
    return data
  },

  listMyAccessRequests: async (): Promise<AccessRequest[]> => {
    const { data } = await client.get('/auth/access-requests')
    return Array.isArray(data) ? data : []
  },

  cancelAccessRequest: async (id: string): Promise<void> => {
    await client.delete(`/auth/access-requests/${id}`)
  },

  adminAccessRequestsPage: async (query: AccessRequestQuery): Promise<AccessRequestPage> => {
    const { data, headers } = await client.get('/auth/admin/access-requests', { params: { ...query, q: query.q || undefined } })
    if (!Array.isArray(data)) throw new Error('Invalid access requests response')
    return { items: data, total: totalHeader(headers) }
  },

  adminApproveAccessRequest: async (id: string, note = ''): Promise<AccessRequest> => {
    const { data } = await client.post(`/auth/admin/access-requests/${id}/approve`, { note })
    return data
  },

  adminRejectAccessRequest: async (id: string, note = ''): Promise<AccessRequest> => {
    const { data } = await client.post(`/auth/admin/access-requests/${id}/reject`, { note })
    return data
  },
}
