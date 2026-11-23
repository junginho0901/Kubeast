// AI Chat 작은 utility. AIChat.tsx 에서 추출 (Phase 3.2).

import { retryAsAsked } from '@/services/queryDefaults'

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

/**
 * The AI model read (`GET /ai/config`) tried again once, as the app's default, but not on a 503 — no model set up yet,
 * or the AI service down, which a second later answers the same — nor on a refusal. A 503 with Retry-After is the
 * server asking to be asked again (ai-service could not check the session while its database is unreadable): asked
 * again until it answers, at retryAsAskedDelay. The rule is the cluster list's (`retryAsAsked`), the 503 aside.
 */
export const aiConfigRetry = retryAsAsked(1, [503])
