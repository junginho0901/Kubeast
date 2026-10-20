// Alerts inbox (ai-service, features.alertInvestigation): every alert Alertmanager sent for the selected cluster,
// firing or resolved, and Kubeast's own handling marks. For whoever reads that cluster as a whole; a mark change
// and opening the alert's investigation report are audited server-side.

import { client } from './client'
import type { Investigation } from './investigations'

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
  investigation: { id: string; status: string } | null
}

export interface AlertInboxDetail extends AlertInboxItem {
  annotations: Record<string, string>
  generator_url: string
  alertmanager_url: string
  receiver: string
  note: string
  note_by: string
  note_at: string | null
}

export interface AlertInboxList {
  items: AlertInboxItem[]
  total: number
  counts: Record<AlertInboxStatus, number>
  stale_hours: number
}

export interface AlertInboxFilter {
  status?: string
  severity?: string
  mine?: boolean
  open?: boolean
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

  listAlertStoreAlerts: async (): Promise<{ alerts: AlertStoreAlert[]; truncated: boolean }> => {
    const { data } = await client.get('/alertstore/alerts', { params: { state: 'all' } })
    // anything but the store's answer (an older gateway serving the page) says nothing about the alerts
    if (!data || typeof data !== 'object' || !Array.isArray(data.alerts)) throw new Error('not an alert store answer')
    return { alerts: data.alerts, truncated: !!data.truncated }
  },
}
