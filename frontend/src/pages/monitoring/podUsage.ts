import { cpuToMillis, memoryToBytes } from '@/utils/resourceQuantity'

// A pod's limit is the sum of its containers' limits, and only when every container sets one: a container
// without a limit can take what the node has, so the pod has none.
export function podLimit(containers: Array<{ limits?: Record<string, string> }> | undefined, resource: 'cpu' | 'memory'): number | null {
  if (!containers || containers.length === 0) return null
  let total = 0
  for (const c of containers) {
    const v = resource === 'cpu' ? cpuToMillis(c.limits?.cpu) : memoryToBytes(c.limits?.memory)
    if (v === null || v <= 0) return null
    total += v
  }
  return total
}

// Usage against the limit: yellow from 60%, red from 80% (the node bars' thresholds); no limit, no colour.
export const usageTone = (pct: number | null) => (pct === null ? 'text-white' : pct >= 80 ? 'text-red-400' : pct >= 60 ? 'text-yellow-400' : 'text-white')
