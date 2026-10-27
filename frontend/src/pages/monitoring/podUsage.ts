import { cpuToMillis, memoryToBytes } from '@/utils/resourceQuantity'

// A pod's limit is the sum of its containers' limits, and only when every container sets one: a container
// without a limit can take what the node has, so the pod has none. The pod list gives a container's limits under
// `resources` (`/cluster/pods/all`); a bare `limits` is read too.
type ContainerLimits = { resources?: { limits?: Record<string, string> }; limits?: Record<string, string> }
export function podLimit(containers: ContainerLimits[] | undefined, resource: 'cpu' | 'memory'): number | null {
  if (!containers || containers.length === 0) return null
  let total = 0
  for (const c of containers) {
    const limits = c.resources?.limits ?? c.limits
    const v = resource === 'cpu' ? cpuToMillis(limits?.cpu) : memoryToBytes(limits?.memory)
    if (v === null || v <= 0) return null
    total += v
  }
  return total
}

// Usage against the limit: yellow from 60%, red from 80% (the node bars' thresholds); no limit, no colour.
export const usageTone = (pct: number | null) => (pct === null ? 'text-white' : pct >= 80 ? 'text-red-400' : pct >= 60 ? 'text-yellow-400' : 'text-white')
