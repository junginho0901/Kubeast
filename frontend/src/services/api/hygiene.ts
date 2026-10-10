import { client } from './client'

// Cluster hygiene report (k8s-service /api/v1/hygiene, gateway /api/v1/cluster/hygiene).
// Every call names its cluster explicitly: the page picks one, not the header selector.

export type HygieneSeverity = 'critical' | 'warning' | 'info'

export interface HygieneConfig {
  enabled: boolean
  interval_days: number
}

export interface HygieneCheck {
  id: string
  severity: HygieneSeverity
  refs: string
  findings: number
  exempt: number
}

export interface HygieneFinding {
  check: string
  severity: HygieneSeverity
  kind: string
  namespace?: string
  name: string
  container?: string
  pods?: number
  // English text (CSV, sign-off snapshots); the screen uses the catalog key and values when present
  message: string
  message_key?: string
  message_args?: Record<string, string>
  exempt?: boolean
  exempt_reason?: string
  exempt_no_reason?: boolean
}

export interface HygieneCounts {
  critical: number
  warning: number
  info: number
  exempt: number
}

export interface HygieneReport {
  generated_at: string
  excluded_namespaces: string[]
  counts: HygieneCounts
  checks: HygieneCheck[]
  findings: HygieneFinding[]
  collectors: { what: string; error: string }[]
  truncated?: boolean
}

export interface HygieneReview {
  id: string
  cluster: string
  reviewed_by_email: string
  reviewed_at: string
  note: string
  counts: HygieneCounts
  snapshot?: { cluster: string; report: HygieneReport }
}

export interface HygieneResponse {
  cluster: string
  interval_days: number
  last_review: HygieneReview | null
  next_due: string | null
  due: boolean
  report: HygieneReport
}

export const hygieneApi = {
  getHygieneConfig: async (): Promise<HygieneConfig> => {
    const { data } = await client.get('/cluster/hygiene/config')
    return { enabled: !!data?.enabled, interval_days: Number(data?.interval_days) || 0 }
  },

  getHygiene: async (cluster: string): Promise<HygieneResponse> => {
    const { data } = await client.get('/cluster/hygiene', { params: { cluster } })
    return data
  },

  // A same-origin link download carries the session cookie; the server names the file.
  hygieneExportUrl: (cluster: string, format: 'csv' | 'json'): string =>
    `/api/v1/cluster/hygiene?${new URLSearchParams({ cluster, format }).toString()}`,

  signoffHygiene: async (cluster: string, note: string): Promise<HygieneReview> => {
    const { data } = await client.post('/cluster/hygiene/signoff', { note }, { params: { cluster } })
    return data
  },

  listHygieneReviews: async (cluster: string): Promise<HygieneReview[]> => {
    const { data } = await client.get('/cluster/hygiene/history', { params: { cluster } })
    return Array.isArray(data) ? data : []
  },

  getHygieneSnapshot: async (cluster: string, id: string): Promise<HygieneReview> => {
    const { data } = await client.get(`/cluster/hygiene/snapshot/${encodeURIComponent(id)}`, { params: { cluster } })
    return data
  },
}
