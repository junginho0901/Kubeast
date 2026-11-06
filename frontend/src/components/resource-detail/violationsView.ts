import { api } from '@/services/api'
import type { PolicyReportResource, PolicyReportResult } from '@/services/api/types'
import { DRAWER_GROUPS } from './crDetail'
import { WORKLOAD_KINDS } from './utils'

// A namespaced resource's rows come from its namespace's PolicyReports and the ClusterPolicyReports naming it, a
// cluster-scoped one's from the ClusterPolicyReports; with the apiVersion, not the rows of an object of another group
// with the same Kind and name.
export const readViolations = (namespace: string, kind: string, name: string, apiVersion?: string) =>
  (namespace ? api.getResourcePolicyReports(namespace, kind, name, false, apiVersion) : api.getClusterResourcePolicyReports(kind, name, false, apiVersion))

// The section's query: an answer asked with an apiVersion is kept apart from one asked without.
export const violationsQuery = (namespace: string, kind: string, name: string, apiVersion?: string) => ({
  queryKey: ['cluster', 'policyreports', 'resource', namespace, kind, name, ...(apiVersion ? [apiVersion] : [])],
  queryFn: () => readViolations(namespace, kind, name, apiVersion),
})

// The apiVersion a drawer asks its rows with: a custom resource's group and version, a built-in workload's group (its
// pods are those of an owner of that group); none for the other kinds, as before.
export function violationsApiVersion(kind: string, rawJson?: Record<string, unknown>): string | undefined {
  if (kind === 'CustomResourceInstance') {
    const group = typeof rawJson?.group === 'string' ? rawJson.group : ''
    const version = typeof rawJson?.version === 'string' ? rawJson.version : ''
    return group && version ? `${group}/${version}` : undefined
  }
  return WORKLOAD_KINDS.has(kind) ? `${DRAWER_GROUPS[kind]}/v1` : undefined
}

// What a drawer's "Policy violations" section shows: nothing while the feature is off, the user is not given policy
// reports (403) or the cluster serves no report kind for the object; else the fail / warn / error rows the reports hold
// about it, "None" without any, or why they could not be read.
export type ViolationsView =
  | { show: 'nothing' }
  | { show: 'loading' }
  | { show: 'error'; reason: string }
  | { show: 'rows'; rows: PolicyReportResult[]; selectorError?: string; clusterReportsError?: string }

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
  const answer = resource.data as PolicyReportResource
  const rows = (answer.rows ?? []).filter((r) => r.result === 'fail' || r.result === 'warn' || r.result === 'error')
  // the results that pick by label could not be held to this object, or the cluster reports could not be read: the rows
  // are not the whole answer
  return {
    show: 'rows',
    rows,
    ...(answer.selector_error ? { selectorError: answer.selector_error } : {}),
    ...(answer.cluster_reports_error ? { clusterReportsError: answer.cluster_reports_error } : {}),
  }
}

// A workload's rows also name its pods, so its section names each row's resource; every other kind's rows are its own.
export const violationsNameTheResource = (kind: string): boolean => WORKLOAD_KINDS.has(kind)

// The Pod and workload drawers place the section themselves; every other drawer gets it after its own sections.
export const violationsAfterInfo = (kind: string, namespace?: string): boolean => !(kind === 'Pod' && !!namespace) && !WORKLOAD_KINDS.has(kind)
