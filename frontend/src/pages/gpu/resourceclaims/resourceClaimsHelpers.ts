// ResourceClaims 페이지의 helper 함수 및 type
//
// frontend/src/pages/gpu/ResourceClaims.tsx 의 parseAgeSeconds /
// formatAge + SortKey 타입 추출. DRA (Dynamic Resource Allocation)
// 의 ResourceClaim 은 namespace-scoped.

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'status'
  | 'requests'
  | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'
