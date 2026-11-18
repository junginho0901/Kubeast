import type { ReactNode } from 'react'
import { useAccessibleClusterSelection, useClusterSettled } from '@/hooks/useAccessibleClusterSelection'

// Layout's body: the selection made among the person's clusters here, and the screen drawn only once it is settled
// (useClusterSettled), so no page reads before a cluster is chosen — the waiting and what ends it in one place.
export default function ClusterGate({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  useAccessibleClusterSelection()
  return useClusterSettled() ? children : fallback
}
