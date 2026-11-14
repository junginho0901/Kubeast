import type { DrainStatusAnswer } from '@/services/api/types'

// What the drain banner shows for a drain status answer (any server answers it, from the database).
export type DrainState = 'idle' | 'pending' | 'draining' | 'success' | 'error' | 'interrupted'

export interface DrainView {
  state: DrainState
  // the drain ended: stop polling
  ended: boolean
  error: string | null
  // null: not read, so the banner says nothing about cordons
  cordoned: string[] | null
  pods: { done: number; total: number } | null
}

export function drainView(a: DrainStatusAnswer): DrainView {
  const cordoned = Array.isArray(a.cordoned_nodes) ? a.cordoned_nodes : null
  const pods = typeof a.pods_total === 'number' ? { done: a.pods_done ?? 0, total: a.pods_total } : null
  switch (a.status) {
    case 'success':
      return { state: 'success', ended: true, error: null, cordoned: null, pods }
    case 'error':
      return { state: 'error', ended: true, error: a.message || 'Failed', cordoned, pods }
    case 'interrupted':
      return { state: 'interrupted', ended: true, error: null, cordoned, pods }
    case 'draining':
      return { state: 'draining', ended: false, error: null, cordoned: null, pods }
    default:
      return { state: 'pending', ended: false, error: null, cordoned: null, pods }
  }
}
