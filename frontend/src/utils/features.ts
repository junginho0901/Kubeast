import type { ClusterFeatures } from '@/services/api/types'

// Chart ai.enabled, as /cluster/features reports it. Unknown (older server, no
// answer yet) counts as on, so a slow features call never hides the AI entry points.
export function aiEnabled(features?: ClusterFeatures | null): boolean {
  return features?.ai?.enabled !== false
}

// Chart features.cost.enabled: the Cost page and the optimization table's cost
// columns. Unknown counts as off — an older server has no /cluster/cost to show.
export function costEnabled(features?: ClusterFeatures | null): boolean {
  return features?.cost?.enabled === true
}

// Chart features.policyReports.enabled: Security → Policy Reports and the
// drawer's "Policy violations" section. Unknown counts as off, as for cost.
export function policyReportsEnabled(features?: ClusterFeatures | null): boolean {
  return features?.policyReports?.enabled === true
}

// Chart features.logSearch for this cluster: the log store keeps its logs. Unknown counts as off, as for cost.
export function logSearchEnabledFor(features: ClusterFeatures | null | undefined, clusterId: string): boolean {
  return features?.logSearch?.enabled === true && !!clusterId && (features.logSearch.clusters ?? []).includes(clusterId)
}

// Chart features.networkFlows for this cluster: Kubeast reads its Hubble Relay. Unknown counts as off.
export function networkFlowsEnabledFor(features: ClusterFeatures | null | undefined, clusterId: string): boolean {
  return features?.networkFlows?.enabled === true && !!clusterId && (features.networkFlows.clusters ?? []).includes(clusterId)
}

// Chart features.tracing: the URL templates of trace links, or undefined when off. Unknown counts as off.
export function traceTemplates(features?: ClusterFeatures | null): { traceUrl?: string; searchUrl?: string } | undefined {
  const t = features?.tracing
  return t?.enabled ? { traceUrl: t.traceUrl || undefined, searchUrl: t.searchUrl || undefined } : undefined
}

// Chart features.alertInvestigation.enabled (with AI on): Admin → Investigations.
// Unknown counts as off, as for cost.
export function alertInvestigationEnabled(features?: ClusterFeatures | null): boolean {
  return features?.alertInvestigation?.enabled === true
}
