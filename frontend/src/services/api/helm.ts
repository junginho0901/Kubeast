// Helm API + Helm-specific types. Unlike the other domain files,
// helm is exposed as a nested namespace (`api.helm.<call>`) for
// historical reasons — call sites all use that form so the shape is
// preserved.

import { client } from './client'

// ===== Helm types =====
// Lived in api.ts originally; consumers import them from
// '@/services/api' directly, so index.ts re-exports these.

export type HelmSection = 'manifest' | 'values' | 'notes' | 'hooks'

export interface HelmReleaseSummary {
  name: string
  namespace: string
  revision: number
  status: string
  chart: string
  chartVersion: string
  appVersion: string
  updated: string
}

export interface HelmReleaseDetail extends HelmReleaseSummary {
  description: string
  values?: Record<string, unknown>
  notes?: string
  manifest?: string
}

export interface HelmHistoryEntry {
  revision: number
  status: string
  chartVersion: string
  appVersion: string
  updated: string
  description: string
}

export interface HelmReleaseResource {
  kind: string
  apiVersion: string
  name: string
  namespace?: string
}

export interface HelmSectionResponse {
  section: HelmSection
  content: string
}

export interface HelmRevisionSectionResponse {
  revision: number
  section: HelmSection
  content: string
}

export interface HelmDiffResponse {
  from: number
  to: number
  section: HelmSection
  diff: string
}

export interface HelmRollbackResponse {
  dryRun: boolean
  fromRevision: number
  toRevision: number
  newRevision?: number
  status?: string
  diff?: string
}

export interface HelmUpgradeResponse {
  dryRun: boolean
  fromRevision: number
  newRevision?: number
  status?: string
  diff?: string
  chartVersion: string
}

export interface HelmUninstallResponse {
  dryRun: boolean
  release: string
  namespace: string
  keepHistory: boolean
  resources?: HelmReleaseResource[]
  info?: string
}

export interface HelmTestHookResult {
  name: string
  phase: string
  logs?: string
  failed: boolean
}

export interface HelmTestResponse {
  success: boolean
  hooks: HelmTestHookResult[]
}

// ===== Helm API =====

export const helmApi = {
  listReleases: async (params?: { namespace?: string; status?: string }): Promise<HelmReleaseSummary[]> => {
    const { data } = await client.get('/helm/releases', { params })
    return Array.isArray(data?.items) ? data.items : []
  },

  getRelease: async (namespace: string, name: string): Promise<HelmReleaseDetail> => {
    const { data } = await client.get(`/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`)
    return data as HelmReleaseDetail
  },

  getSection: async (
    namespace: string,
    name: string,
    section: HelmSection,
  ): Promise<HelmSectionResponse> => {
    const { data } = await client.get(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${section}`,
    )
    return data as HelmSectionResponse
  },

  getHistory: async (namespace: string, name: string): Promise<HelmHistoryEntry[]> => {
    const { data } = await client.get(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/history`,
    )
    return Array.isArray(data?.items) ? data.items : []
  },

  getRevisionSection: async (
    namespace: string,
    name: string,
    revision: number,
    section: HelmSection,
  ): Promise<HelmRevisionSectionResponse> => {
    const { data } = await client.get(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/revisions/${revision}/${section}`,
    )
    return data as HelmRevisionSectionResponse
  },

  getResources: async (namespace: string, name: string): Promise<HelmReleaseResource[]> => {
    const { data } = await client.get(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/resources`,
    )
    return Array.isArray(data?.items) ? data.items : []
  },

  getImages: async (namespace: string, name: string): Promise<string[]> => {
    const { data } = await client.get(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/images`,
    )
    return Array.isArray(data?.items) ? data.items : []
  },

  diff: async (
    namespace: string,
    name: string,
    payload: { from: number; to: number; section: HelmSection },
  ): Promise<HelmDiffResponse> => {
    const { data } = await client.post(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/diff`,
      payload,
    )
    return data as HelmDiffResponse
  },

  rollback: async (
    namespace: string,
    name: string,
    payload: { revision: number; dryRun: boolean },
  ): Promise<HelmRollbackResponse> => {
    const { data } = await client.post(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/rollback`,
      payload,
    )
    return data as HelmRollbackResponse
  },

  upgradeValues: async (
    namespace: string,
    name: string,
    payload: { values: string; dryRun: boolean },
  ): Promise<HelmUpgradeResponse> => {
    const { data } = await client.put(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/values`,
      payload,
    )
    return data as HelmUpgradeResponse
  },

  test: async (namespace: string, name: string): Promise<HelmTestResponse> => {
    const { data } = await client.post(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/test`,
    )
    return data as HelmTestResponse
  },

  uninstall: async (
    namespace: string,
    name: string,
    opts: { keepHistory?: boolean; dryRun?: boolean },
  ): Promise<HelmUninstallResponse> => {
    const { data } = await client.delete(
      `/helm/releases/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
      {
        params: {
          ...(opts.keepHistory !== undefined ? { keepHistory: opts.keepHistory } : {}),
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
          // The server refuses a real uninstall unless the release name is echoed back.
          ...(opts.dryRun ? {} : { confirm: name }),
        },
      },
    )
    return data as HelmUninstallResponse
  },
}
