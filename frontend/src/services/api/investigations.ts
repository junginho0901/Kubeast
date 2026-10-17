// Alert investigation reports (ai-service, features.alertInvestigation): what the
// AI found with the read-only tools when Alertmanager or Grafana sent an alert. Listing
// needs admin.investigations.read; opening one is audited (ai.investigation.view)
// because a report can quote pod logs.

import { client } from './client'

export type InvestigationStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export interface InvestigationSummary {
  id: string
  cluster: string
  alertname: string
  severity: string
  namespace: string
  status: InvestigationStatus
  skip_reason: string
  received_at: string
  started_at: string | null
  finished_at: string | null
  repeat_count: number
  last_seen_at: string
  model: string
  total_tokens: number | null
  iterations: number
  tool_call_count: number
  duration_ms: number | null
}

export interface InvestigationToolCall {
  tool: string
  args: Record<string, unknown>
  step: number
  result_chars?: number
  error?: string
}

export interface Investigation extends InvestigationSummary {
  fingerprint: string
  labels: Record<string, string>
  annotations: Record<string, string>
  starts_at: string | null
  generator_url: string
  alertmanager_url: string
  provider: string
  prompt_tokens: number | null
  completion_tokens: number | null
  tool_calls: InvestigationToolCall[]
  report: string
  error: string
}

export interface InvestigationFilter {
  status?: string
  cluster?: string
  limit?: number
  offset?: number
}

const base = '/ai/investigations'

export const investigationsApi = {
  listInvestigations: async (filter: InvestigationFilter = {}): Promise<{ items: InvestigationSummary[]; total: number }> => {
    // cluster is a filter here, not the selected cluster the client adds by default
    const params: Record<string, string> = { cluster: '' }
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params[k] = String(v)
    const { data } = await client.get(base, { params })
    return { items: Array.isArray(data?.items) ? data.items : [], total: Number(data?.total ?? 0) }
  },

  getInvestigation: async (id: string): Promise<Investigation> => {
    const { data } = await client.get(`${base}/${encodeURIComponent(id)}`, { params: { cluster: '' } })
    return data
  },
}
