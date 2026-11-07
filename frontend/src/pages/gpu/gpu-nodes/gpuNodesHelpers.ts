import type { GPUNodeInfo } from '@/services/api'
import { vendorNames } from '../gpuNumbers'

export type SortKey = null | 'name' | 'gpu_vendor' | 'gpu_model' | 'gpu_memory' | 'gpu_capacity' | 'gpu_allocatable' | 'status' | 'mig_strategy'
export type SummaryCard = [label: string, value: number | string, boxClass: string, labelClass: string]

// one badge per part of kubectl's STATUS (Ready,SchedulingDisabled), as the Nodes list draws it
export { nodeStatusBadge as getStatusColor } from '@/utils/nodeStatus'

const MEBIBYTES: Record<string, number> = { m: 1, g: 1024, t: 1024 * 1024 }

// A cell's size in MiB to sort by: GPU Feature Discovery's label is a bare number of mebibytes, AMD's node labeller writes
// "192G". A node with several companies' GPUs lists each, and reads by its largest; -1 with no size, first going up.
export function gpuMemoryMiB(memory?: string | null): number {
  const sizes = String(memory ?? '').split(',').map((part) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([mgt])?(?:i?b)?\s*$/i.exec(part)
    return m ? Number(m[1]) * MEBIBYTES[(m[2] ?? 'm').toLowerCase()] : -1
  })
  return Math.max(...sizes)
}

export function sortGPUNodes(nodes: GPUNodeInfo[], sortKey: SortKey, sortDir: 'asc' | 'desc'): GPUNodeInfo[] {
  if (!sortKey) return nodes
  const list = [...nodes]
  const getValue = (node: GPUNodeInfo): string | number => {
    switch (sortKey) {
      case 'name': return node.name
      case 'gpu_vendor': return vendorNames(node.gpu_vendors)
      case 'gpu_model': return node.gpu_model ?? ''
      case 'gpu_memory': return gpuMemoryMiB(node.gpu_memory)
      case 'gpu_capacity': return node.gpu_capacity
      case 'gpu_allocatable': return node.gpu_allocatable
      case 'status': return node.status
      case 'mig_strategy': return node.mig_strategy ?? ''
      default: return ''
    }
  }
  list.sort((a, b) => {
    const av = getValue(a)
    const bv = getValue(b)
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av
    }
    return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
  })
  return list
}
