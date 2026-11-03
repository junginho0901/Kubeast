// ResourceClaims 페이지의 helper 함수 및 type
//
// frontend/src/pages/gpu/ResourceClaims.tsx 의 parseAgeSeconds /
// formatAge + SortKey 타입 추출. DRA (Dynamic Resource Allocation)
// 의 ResourceClaim 은 namespace-scoped.

import type { ResourceClaimItem } from '@/services/api'

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'state'
  | 'requests'
  | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'

// kubectl's STATE as its words: "allocated,reserved" → allocated, reserved
export const stateWords = (state?: string) => (state ?? '').split(',').filter(Boolean)

// The cards count kubectl's STATE: a card counts the claims whose STATE has its word, so a claim in use
// (allocated,reserved) is Allocated and Reserved both, and one being deleted is Pending no more.
export function claimCards(items: ResourceClaimItem[]) {
  const has = (item: ResourceClaimItem, word: string) => stateWords(item.state).includes(word)
  return {
    total: items.length,
    allocated: items.filter((i) => has(i, 'allocated')).length,
    reserved: items.filter((i) => has(i, 'reserved')).length,
    pending: items.filter((i) => has(i, 'pending')).length,
  }
}
