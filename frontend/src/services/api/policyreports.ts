// Policy reports (wgpolicyk8s.io, features.policyReports). A cluster without the CRD answers the
// data routes with an empty array and the not-installed header; the page asks status first.
import { client } from './client'
import type { PolicyReportResource, PolicyReportResults, PolicyReportStatus, PolicyReportSummary } from './types'

export interface PolicyReportResultsQuery {
  namespace?: string
  policy?: string
  kind?: string
  search?: string
  result?: string
  severity?: string
  limit?: number
}

// force: read the cluster again instead of the server's one-minute cache (the refresh button).
export const policyReportsApi = {
  getPolicyReportStatus: async (): Promise<PolicyReportStatus> => {
    const { data } = await client.get('/cluster/policyreports/status')
    return data
  },

  getPolicyReportSummary: async (namespace?: string, force = false): Promise<PolicyReportSummary | unknown[]> => {
    const { data } = await client.get('/cluster/policyreports/summary', { params: { namespace: namespace || undefined, force_refresh: force || undefined } })
    return data
  },

  getPolicyReportResults: async (q: PolicyReportResultsQuery, force = false): Promise<PolicyReportResults | unknown[]> => {
    const { data } = await client.get('/cluster/policyreports/results', {
      params: {
        namespace: q.namespace || undefined,
        policy: q.policy || undefined,
        kind: q.kind || undefined,
        search: q.search || undefined,
        result: q.result || undefined,
        severity: q.severity || undefined,
        limit: q.limit,
        force_refresh: force || undefined,
      },
    })
    return data
  },

  getResourcePolicyReports: async (namespace: string, kind: string, name: string, force = false): Promise<PolicyReportResource | unknown[]> => {
    const { data } = await client.get(`/cluster/namespaces/${encodeURIComponent(namespace)}/policyreports/resource`, { params: { kind, name, force_refresh: force || undefined } })
    return data
  },
}
