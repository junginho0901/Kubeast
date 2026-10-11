// ResourceClaimTemplates 페이지의 helper 함수 및 type
//
// frontend/src/pages/gpu/ResourceClaimTemplates.tsx 의 parseAgeSeconds /
// formatAge + SortKey 타입 추출. DRA 의 ResourceClaimTemplate 은
// namespace-scoped, status/allocation 없이 spec.spec.devices.requests 만 보유.

export type SortKey =
  | null
  | 'name'
  | 'namespace'
  | 'requests'
  | 'age'

export { ageSeconds as parseAgeSeconds, formatAge } from '@/utils/time'
