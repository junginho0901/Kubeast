// Alert investigation reports (ai-service, features.alertInvestigation): what the
// AI found with the read-only tools when Alertmanager or Grafana sent an alert. Listing
// needs admin.investigations.read; opening one is audited (ai.investigation.view)
// because a report can quote pod logs.

import { client } from './client'
import type { ToolAccess } from '@/services/toolAccess'

export type InvestigationStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export interface InvestigationSummary {
  id: string
  cluster: string
  alertname: string
  severity: string
  namespace: string
  status: InvestigationStatus
  skip_reason: string
  // the catalog key and values of skip_reason (investigations.skip.<key>); empty for text written another way
  skip_reason_key?: string
  skip_reason_args?: Record<string, string | number>
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
  // The identity the call reached the cluster as (absent when it reached none)
  access?: ToolAccess
}

// A call number of the report's rca block, given with the call it names (its place in tool_calls, from 1).
export interface InvestigationCallRef {
  call: number
  tool: string
  // the call was refused or failed
  failed?: boolean
}

export type HypothesisState = 'cause' | 'symptom' | 'ruled_out' | 'blocked' | 'open'

export interface InvestigationHypothesis {
  id: string
  statement: string
  resource: string
  state: HypothesisState
  for: InvestigationCallRef[]
  against: InvestigationCallRef[]
  blocked?: string
  closed: boolean
  problems?: { reason: 'open' | 'no_evidence' | 'no_reason' | 'bad_calls' | 'not_verified'; side?: 'for' | 'against'; calls?: string[] }[]
  // a side when the model gave more numbers than the server keeps
  cut?: { for?: InvestigationCut; against?: InvestigationCut }
}

export type UnverifiedReason = 'no_evidence' | 'bad_calls' | 'empty_answer' | 'name_missing' | 'after_alert'

// A list the server cut at what it keeps of it: how many items the model gave and how many are kept (the first ones).
export interface InvestigationCut {
  given: number
  kept: number
}

export interface InvestigationCause {
  resource: string
  kind: string
  started_at: string | null
  evidence: InvestigationCallRef[]
  // the numbers as the model gave them, those that name no call of the run too (the AI evaluation counts them)
  raw_evidence?: (number | string)[]
  // with evidenceCheck: whether the run's calls show the cause, and why not (absent for kind none)
  verified?: boolean
  reason?: UnverifiedReason
  // its evidence when the model gave more numbers than the server keeps
  cut?: { evidence?: InvestigationCut }
}

// features.alertInvestigation.verdict: which of three answers the report gives, as the server keeps it.
export type InvestigationOutcome = 'cause_found' | 'no_fault' | 'cannot_tell'

// A check the server saw find nothing: anomaly_rank's, or an issue check that listed nothing.
export interface InvestigationChecked {
  check: string
  call: number
  tool: string
  namespace?: string
  workload?: string
  since?: string
  until?: string
  // the check read only a part, and what it could not read
  partial?: string
}

// What the run's calls did not look at: a source no call read, a check anomaly_rank did not run, a call that gave no answer.
export interface InvestigationNotLookedAt {
  reason: 'not_offered' | 'not_called' | 'no_answer' | 'not_run' | 'failed' | 'unavailable' | 'not_found'
  source?: string
  check?: string
  call?: number
  tool?: string
  namespace?: string
  workload?: string
  detail?: string
}

// The outcome and the server's lists, made from the run's calls; nothing in the lists is the model's.
export interface InvestigationVerdict {
  // null: the report ended without a block the server could read
  outcome: InvestigationOutcome | null
  // what the block says; another outcome than it when the calls do not hold it (why)
  said: InvestigationOutcome | null
  why: string[]
  symptom?: { resource: string; evidence: InvestigationCallRef[]; cut?: { evidence?: InvestigationCut } }
  looked_at: { source: string; calls: InvestigationCallRef[]; cut?: { calls?: InvestigationCut } }[]
  checked_normal: InvestigationChecked[]
  not_looked_at: InvestigationNotLookedAt[]
  cut?: { checked_normal?: InvestigationCut; not_looked_at?: InvestigationCut }
}

// What the server read of the report's rca block (evidenceCheck or ledger on; absent with both off).
export interface InvestigationResult {
  version: number
  // ok: read; missing / invalid: no block it could read; cut: the answer stopped inside its block
  status: 'ok' | 'missing' | 'invalid' | 'cut'
  no_fault: boolean | null
  causes: InvestigationCause[]
  path: string[]
  ruled_out: string[]
  hypotheses: InvestigationHypothesis[]
  asked_again: boolean
  ask_failed?: boolean
  // what the checks still found wrong, each a kind of the server's rca.FAILURES
  failures?: { kind: string; resource?: string; id?: string; finish_reason?: string }[]
  // the switches that read the block; absent on a row written before it was kept
  checks?: { evidence: boolean; ledger: boolean }
  // the lists the model gave longer than the server keeps; absent when every list fits
  cut?: { causes?: InvestigationCut; path?: InvestigationCut; ruled_out?: InvestigationCut; hypotheses?: InvestigationCut }
  // the outcome (verdict on); absent with it off and on a row written before it
  verdict?: InvestigationVerdict
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
  result?: InvestigationResult
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
