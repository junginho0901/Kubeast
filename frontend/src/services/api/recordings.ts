// Terminal session recordings — the output of pod exec / node shell terminals
// recorded as asciicast (k8s-service, behind the gateway's /api/v1/cluster
// prefix). Listing needs admin.sessions.read; reading a recording's body is
// audited (admin.session.read) on every request.

import { client } from './client'

export interface RecordingsConfig {
  enabled: boolean
}

export type RecordingStatus = 'recording' | 'uploading' | 'uploaded' | 'interrupted'

export interface SessionRecording {
  id: string
  kind: 'exec' | 'node-shell'
  user_id?: string
  user_email?: string
  cluster: string
  namespace?: string
  target: string
  container?: string
  storage: string
  started_at: string
  ended_at?: string
  bytes: number
  uploaded_bytes: number
  parts: number
  status: RecordingStatus
  truncated: boolean
  last_error?: string
}

export interface RecordingFilter {
  user?: string
  cluster?: string
  kind?: string
  limit?: number
  offset?: number
}

const base = '/cluster/recordings'

export const recordingsApi = {
  getRecordingsConfig: async (): Promise<RecordingsConfig> => {
    const { data } = await client.get(`${base}/config`)
    return { enabled: !!data?.enabled }
  },

  listRecordings: async (filter: RecordingFilter = {}): Promise<SessionRecording[]> => {
    // cluster is a filter here, not the selected cluster the client adds by default
    const params: Record<string, string> = { cluster: '' }
    for (const [k, v] of Object.entries(filter)) if (v) params[k] = String(v)
    const { data } = await client.get(base, { params })
    return Array.isArray(data) ? data : []
  },
}

// Same-origin URLs (the session cookie goes along) for the player and downloads.
export const recordingCastUrl = (id: string) => `/api/v1${base}/${encodeURIComponent(id)}/cast`
export const recordingDownloadUrl = (id: string) => `${recordingCastUrl(id)}?download=1`
export const recordingTextUrl = (id: string) => `${recordingCastUrl(id)}?format=text`
