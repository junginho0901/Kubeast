import { api } from '@/services/api'
import type { PolicyReportResource, PolicyReportResult } from '@/services/api/types'
import { WORKLOAD_KINDS } from './utils'

// A namespaced resource's rows come from its namespace's PolicyReports, a cluster-scoped one's from the
// ClusterPolicyReports.
export const readViolations = (namespace: string, kind: string, name: string) =>
  (namespace ? api.getResourcePolicyReports(namespace, kind, name) : api.getClusterResourcePolicyReports(kind, name))

// What a drawer's "Policy violations" section shows: nothing while the feature is off, the user is not given policy
// reports (403) or the cluster serves no report kind for the object; else the fail / warn / error rows the reports hold
// about it, "None" without any, or why they could not be read.
export type ViolationsView =
  | { show: 'nothing' }
  | { show: 'loading' }
  | { show: 'error'; reason: string }
  | { show: 'rows'; rows: PolicyReportResult[] }

type Read = { data?: unknown; error?: unknown }

const httpStatus = (err: unknown): number | undefined => (err as any)?.response?.status
const reasonOf = (err: unknown): string => String((err as any)?.response?.data?.detail ?? (err as any)?.message ?? '').trim()

export function violationsView(on: boolean, status: Read, resource: Read): ViolationsView {
  if (!on) return { show: 'nothing' }
  if (status.error) return httpStatus(status.error) === 403 ? { show: 'nothing' } : { show: 'error', reason: reasonOf(status.error) }
  if ((status.data as { installed?: boolean } | undefined)?.installed !== true) return { show: 'nothing' }
  if (resource.error) return { show: 'error', reason: reasonOf(resource.error) }
  if (resource.data === undefined) return { show: 'loading' }
  // the not-installed answer of a report kind the cluster does not serve
  if (Array.isArray(resource.data)) return { show: 'nothing' }
  const rows = ((resource.data as PolicyReportResource).rows ?? []).filter((r) => r.result === 'fail' || r.result === 'warn' || r.result === 'error')
  return { show: 'rows', rows }
}

// A workload's rows also name its pods, so its section names each row's resource; every other kind's rows are its own.
export const violationsNameTheResource = (kind: string): boolean => WORKLOAD_KINDS.has(kind)

// The Pod and workload drawers place the section themselves; every other drawer gets it after its own sections.
export const violationsAfterInfo = (kind: string, namespace?: string): boolean => !(kind === 'Pod' && !!namespace) && !WORKLOAD_KINDS.has(kind)
