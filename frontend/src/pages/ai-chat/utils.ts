// AI Chat 작은 utility. AIChat.tsx 에서 추출 (Phase 3.2).

/**
 * Optimistic UI 용 임시 세션 ID 판정 — `temp:` prefix.
 * 임시 세션은 useQuery 의 sessionDetail fetch 를 disabled 하고 (아직 DB 없음)
 * welcome 화면도 표시 (실제 세션이 아니므로).
 */
export const isTempSessionId = (id: string | null) =>
  typeof id === 'string' && id.startsWith('temp:')

// The conversation list's failure line: the delete or rename refused last (by when each was sent).
export function sessionListFailure(
  deleteError: unknown, deleteSentAt: number, renameError: unknown, renameSentAt: number,
): { error: unknown; action: 'delete' | 'change' } | null {
  const del = deleteError ? { error: deleteError, action: 'delete' as const, at: deleteSentAt } : null
  const ren = renameError ? { error: renameError, action: 'change' as const, at: renameSentAt } : null
  const last = del && ren ? (del.at >= ren.at ? del : ren) : del ?? ren
  return last ? { error: last.error, action: last.action } : null
}

type FailedRead = { response?: { status?: number; headers?: Record<string, unknown> & { get?: (name: string) => unknown } } } | null

/** The wait a failed answer's Retry-After asks for (RFC 9110 §10.2.3: seconds or a date), in ms; null without one. */
function retryAfterMs(error: unknown): number | null {
  const headers = (error as FailedRead)?.response?.headers
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after']
  if (value == null || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * The AI model read (`GET /ai/config`) tried again once, as the app's default, but not on a 503 — no model set up yet,
 * or the AI service down, which a second later answers the same — nor on a refusal. A 503 with Retry-After is the
 * server asking to be asked again (ai-service could not check the session while its database is unreadable): asked
 * again until it answers, at aiConfigRetryDelay.
 */
export function aiConfigRetry(failureCount: number, error: unknown): boolean {
  const status = (error as FailedRead)?.response?.status
  if (status === 403) return false
  if (retryAfterMs(error) !== null) return true
  return failureCount < 1 && status !== 503
}

/** react-query's wait growing to 30 s, never shorter than the answer's Retry-After. */
export const aiConfigRetryDelay = (failureCount: number, error: unknown): number =>
  Math.max(retryAfterMs(error) ?? 0, Math.min(1000 * 2 ** failureCount, 30_000))
