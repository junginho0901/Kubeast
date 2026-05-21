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

export function parseAgeSeconds(createdAt?: string | null): number {
  if (!createdAt) return 0
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return 0
  return Math.max(0, Math.floor((Date.now() - ms) / 1000))
}

export function formatAge(createdAt?: string | null): string {
  const sec = parseAgeSeconds(createdAt)
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
