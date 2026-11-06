import { buildResourceLink } from '@/utils/resourceLink'

// The server lists one row per container and field; "Violating Pods" counts the pods.
export function violatingPodCount(violations: Array<{ pod: string; namespace?: string }>): number {
  return new Set(violations.map((v) => `${v.namespace ?? ''}/${v.pod}`)).size
}

interface ViolationRow {
  pod: string
  namespace?: string
  container: string
  field: string
  actual: string
  limit: string
}

// As many rows as the workload windows send of their pods.
const AI_ROWS = 20

export interface ViolationsUnread {
  status?: number
  detail?: string
}

// Why the list could not be read, as the window says it; nothing while it has not answered.
export function violationsUnread(error: unknown): ViolationsUnread | undefined {
  if (!error) return undefined
  const response = (error as { response?: { status?: number; data?: { detail?: unknown } } }).response
  const detail = response?.data?.detail
  return {
    ...(response?.status ? { status: response.status } : {}),
    ...(typeof detail === 'string' && detail ? { detail } : {}),
  }
}

// What the floating chat is told of the "Violating Pods" section; nothing until the list has answered, so a window does
// not claim "none" it never read, and why when it could not read it.
export function limitRangeViolationsLayer(violations: ViolationRow[] | undefined, unread?: ViolationsUnread): Record<string, unknown> | undefined {
  if (!violations) return unread ? { violations_unread: unread } : undefined
  const rows = violations.slice(0, AI_ROWS)
  return {
    violating_pods: violatingPodCount(violations),
    violation_rows: violations.length,
    violations_shown: rows.length,
    violations: rows.map((v) => ({
      pod: v.pod,
      container: v.container,
      field: v.field,
      actual: v.actual,
      limit: v.limit,
      _link: buildResourceLink('Pod', v.namespace, v.pod),
    })),
  }
}

export function limitRangeViolationsSummary(name: string, namespace: string, violations: ViolationRow[] | undefined, unread?: ViolationsUnread): string {
  const head = `LimitRange ${name} (${namespace}) 상세`
  if (!violations) return unread ? `${head} — 위반 Pod 목록을 읽지 못함` : head
  if (violations.length === 0) return `${head} — 위반 Pod 0개`
  return `⚠️ ${head} — 위반 Pod ${violatingPodCount(violations)}개, 위반 행 ${violations.length}개`
}
