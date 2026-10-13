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
