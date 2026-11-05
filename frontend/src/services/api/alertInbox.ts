// Alerts inbox (ai-service, features.alertInvestigation): every alert Alertmanager sent for the selected cluster,
// firing or resolved, and Kubeast's own handling marks. For whoever reads that cluster as a whole; a mark change,
// opening the alert's investigation report and "Investigate now" are audited server-side.

import { client } from './client'
import type { Investigation } from './investigations'
import type { SkipReason } from '@/utils/investigationFormat'

export type AlertInboxStatus = 'firing' | 'stale' | 'resolved'

export interface AlertInboxItem {
  id: string
  cluster: string
  fingerprint: string
  alertname: string
  severity: string
  namespace: string
  labels: Record<string, string>
  summary: string
  status: AlertInboxStatus
  starts_at: string
  resolved_at: string | null
  first_received_at: string
  last_received_at: string
  received_count: number
  acknowledged: boolean
  acked_by: string
  acked_at: string | null
  assignee: string
  done: boolean
  done_by: string
  done_at: string | null
  // the alert's investigation; skip_reason (with its catalog key) when it was skipped; requested_by is who asked for it
  // here ("" when the webhook queued it), received_at when it was queued
  investigation: ({ id: string; status: string; requested_by?: string; received_at?: string | null } & SkipReason) | null
}

// The alert window's "Investigate now" for the signed-in user, as the server decides it: allowed, or why not and when
// it works again (until, UTC), with today's token budget of asked-for investigations and their use (UTC day).
export interface InvestigateNowState {
  permission: string
  allowed: boolean
  reason: '' | 'forbidden' | 'investigating' | 'investigated' | 'manual_off' | 'provider_paused' | 'manual_budget'
  until: string | null
  // whether the webhook investigates by itself (features.alertInvestigation.automatic)
  automatic: boolean
  budget: number
  used: number
}

export interface AlertInboxDetail extends AlertInboxItem {
  annotations: Record<string, string>
  generator_url: string
  alertmanager_url: string
  receiver: string
  note: string
  note_by: string
  note_at: string | null
  // absent from a server before "Investigate now"
  investigate_now?: InvestigateNowState
}

export interface AlertInboxList {
  items: AlertInboxItem[]
  total: number
  counts: Record<AlertInboxStatus, number>
  stale_hours: number
  // the severity values the cluster's alerts carry (for the filter)
  severities: string[]
}

export interface AlertInboxFilter {
  status?: string
  severity?: string
  mine?: boolean
  open?: boolean
  /** matched by the server in the alert name, namespace, assignee, labels and annotations */
  q?: string
  limit?: number
  offset?: number
}

export interface AlertInboxMarks {
  acknowledged?: boolean
  assignee?: 'me' | ''
  note?: string
  done?: boolean
}

// The alert store's view of the same alerts (k8s-service, features.alertStore): state by fingerprint.
export interface AlertStoreAlert {
  fingerprint: string
  state: string
  silencedBy?: string[]
}

// A silence's label condition (Alertmanager API v2), and a silence as the alert store lists it.
export interface SilenceMatcher {
  name: string
  value: string
  isRegex: boolean
  isEqual: boolean
}

export interface AlertSilence {
  id: string
  state: string
  // how it reaches this cluster's alerts: its own (carries the cluster condition), every cluster's (no cluster
  // condition), or a cluster pattern this cluster meets; only its own can be ended here
  scope?: 'cluster' | 'all' | 'pattern'
  matchers: string[]
  createdBy?: string
  comment?: string
  startsAt: string
  endsAt: string
}

export interface SilencePreview {
  total: number
  truncated: boolean
  alerts: { fingerprint: string; alertname: string; severity?: string; state: string; labels: Record<string, string> }[]
}

const base = '/alerts/inbox'

export const alertInboxApi = {
  listAlertInbox: async (filter: AlertInboxFilter = {}): Promise<AlertInboxList> => {
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '' && v !== false) params[k] = String(v)
    const { data } = await client.get(base, { params })
    return {
      items: Array.isArray(data?.items) ? data.items : [],
      total: Number(data?.total ?? 0),
      counts: { firing: 0, stale: 0, resolved: 0, ...(data?.counts ?? {}) },
      stale_hours: Number(data?.stale_hours ?? 8),
      severities: Array.isArray(data?.severities) ? data.severities : [],
    }
  },

  getAlertInboxItem: async (id: string): Promise<AlertInboxDetail> => {
    const { data } = await client.get(`${base}/${encodeURIComponent(id)}`)
    return data
  },

  setAlertInboxMarks: async (id: string, marks: AlertInboxMarks): Promise<AlertInboxDetail> => {
    const { data } = await client.patch(`${base}/${encodeURIComponent(id)}`, marks)
    return data
  },

  // "Investigate now": queued as the webhook queues one (audited ai.investigation.request); the answer is the alert
  // window, with started false when this firing's investigation was queued, running or done already
  investigateAlertInboxItem: async (id: string): Promise<AlertInboxDetail & { started: boolean }> => {
    const { data } = await client.post(`${base}/${encodeURIComponent(id)}/investigate`)
    return data
  },

  getAlertInboxInvestigation: async (id: string): Promise<Investigation> => {
    const { data } = await client.get(`${base}/${encodeURIComponent(id)}/investigation`)
    return data
  },

  listAlertSilences: async (): Promise<AlertSilence[]> => {
    const { data } = await client.get('/alertstore/silences')
    if (!data || typeof data !== 'object' || !Array.isArray(data.silences)) throw new Error('not an alert store answer')
    return data.silences
  },

  previewAlertSilence: async (matchers: SilenceMatcher[]): Promise<SilencePreview> => {
    const { data } = await client.get('/alertstore/silences/preview', { params: { matchers: JSON.stringify(matchers) } })
    return { total: Number(data?.total ?? 0), truncated: !!data?.truncated, alerts: Array.isArray(data?.alerts) ? data.alerts : [] }
  },

  createAlertSilence: async (body: { matchers: SilenceMatcher[]; durationMinutes: number; comment: string }): Promise<{ silenceID: string }> => {
    const { data } = await client.post('/alertstore/silences', body)
    return data
  },

  expireAlertSilence: async (id: string): Promise<void> => {
    await client.delete(`/alertstore/silences/${encodeURIComponent(id)}`)
  },

  listAlertStoreAlerts: async (): Promise<{ alerts: AlertStoreAlert[]; total: number; truncated: boolean }> => {
    const { data } = await client.get('/alertstore/alerts', { params: { state: 'all' } })
    // anything but the store's answer (an older gateway serving the page) says nothing about the alerts
    if (!data || typeof data !== 'object' || !Array.isArray(data.alerts)) throw new Error('not an alert store answer')
    return { alerts: data.alerts, total: Number(data.total ?? data.alerts.length), truncated: !!data.truncated }
  },
}
