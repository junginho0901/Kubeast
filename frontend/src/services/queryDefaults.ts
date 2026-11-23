import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

import { isForbiddenError, type Member } from '@/services/api'

// A read refused (403) answers the same until the person's access changes: it is not tried again, nor asked again on a
// timer. Opening the screen again, choosing another cluster or a change of the person's access (another answer of
// /auth/me) asks once more, as for a refused metrics read (metricsReadPace), and so does the person's return to the tab
// a minute or more after the refusal, for access changed in the cluster itself (its RBAC edited, a role made again
// during an upgrade), which /auth/me does not show. Another failure is tried as before.

/** Tries a failed read again up to `times` more, a refused one never. */
export const retryUnlessRefused = (times: number) => (failureCount: number, error: unknown): boolean =>
  failureCount < times && !isForbiddenError(error)

type FailedRead = { response?: { status?: number; headers?: Record<string, unknown> & { get?: (name: string) => unknown } } } | null

/** The wait a failed answer's Retry-After asks for (RFC 9110 §10.2.3: seconds or a date), in ms; null without one. */
export function retryAfterMs(error: unknown): number | null {
  const headers = (error as FailedRead)?.response?.headers
  const value = headers?.get?.('retry-after') ?? headers?.['retry-after']
  if (value == null || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

/**
 * retryUnlessRefused, and a failure whose answer carries Retry-After (a 503 while the session store's database
 * restarts) asked again for as long as the answers say so, at retryAsAskedDelay. A status in `answersTheSame` without
 * Retry-After is not tried again, as a refusal is not: a read that a second later answers the same (the AI model
 * read's 503, no model set up yet or the AI service down).
 */
export const retryAsAsked = (times: number, answersTheSame: readonly number[] = []) => (failureCount: number, error: unknown): boolean => {
  if (isForbiddenError(error)) return false
  if (retryAfterMs(error) !== null) return true
  const status = (error as FailedRead)?.response?.status
  return failureCount < times && (status === undefined || !answersTheSame.includes(status))
}

/** react-query's wait growing to 30 s, never shorter than the answer's Retry-After. */
export const retryAsAskedDelay = (failureCount: number, error: unknown): number =>
  Math.max(retryAfterMs(error) ?? 0, Math.min(1000 * 2 ** failureCount, 30_000))

/** How long after a refusal the person's return to the tab asks the refused read once more. */
export const REFUSED_ON_RETURN_MS = 60_000

/** TanStack Query's window focus refetch (the tab shown again) for a read refused a minute or more before, no other. */
export const askRefusedOnReturn = (query: { state: { error: unknown; errorUpdatedAt: number } }): boolean =>
  isForbiddenError(query.state.error) && Date.now() - query.state.errorUpdatedAt >= REFUSED_ON_RETURN_MS

/** The app's query defaults (main.tsx). */
export const queryDefaults = {
  refetchOnWindowFocus: askRefusedOnReturn,
  retry: retryUnlessRefused(1),
}

/** `every`, or false once the read was refused: a timer that stops there. */
export const unlessRefused = (error: unknown, every: number | false | undefined): number | false =>
  isForbiddenError(error) ? false : every ?? false

/** A read asked again every `ms` until it is refused. */
export const everyUntilRefused = (ms: number) => (query: { state: { error: unknown } }): number | false =>
  unlessRefused(query.state.error, ms)

/** Each read on screen the cluster or Kubeast refused asks once more. */
export function askRefusedAgain(queryClient: QueryClient): Promise<void> {
  return queryClient.refetchQueries({ type: 'active', predicate: (q) => isForbiddenError(q.state.error) }, { cancelRefetch: false })
}

// What of /auth/me decides what the person may read.
const accessOf = (me: Member | undefined): string | undefined =>
  me ? JSON.stringify([me.role ?? null, me.permissions_matrix ?? null, me.cluster_roles ?? null, me.cluster_namespaces ?? null]) : undefined

/** When /auth/me answers with other access than before, each read on screen that was refused asks once more. */
export function useAskRefusedOnAccessChange(me: Member | undefined): void {
  const queryClient = useQueryClient()
  const before = useRef<string | undefined>(undefined)
  const access = accessOf(me)
  useEffect(() => {
    if (access === undefined) return
    const was = before.current
    before.current = access
    if (was !== undefined && was !== access) void askRefusedAgain(queryClient)
  }, [access, queryClient])
}
