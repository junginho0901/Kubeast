import type { ClusterFeatures } from '@/services/api/types'

// Chart ai.enabled, as /cluster/features reports it. Unknown (older server, no
// answer yet) counts as on, so a slow features call never hides the AI entry points.
export function aiEnabled(features?: ClusterFeatures | null): boolean {
  return features?.ai?.enabled !== false
}
