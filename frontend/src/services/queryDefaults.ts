import { useEffect, useRef } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

import { isForbiddenError, type Member } from '@/services/api'

// A read refused (403) answers the same until the person's access changes: it is not tried again, nor asked again on a
// timer. Opening the screen again, choosing another cluster or a change of the person's access (another answer of
// /auth/me) asks once more, as for a refused metrics read (metricsReadPace). Another failure is tried as before.

/** Tries a failed read again up to `times` more, a refused one never. */
export const retryUnlessRefused = (times: number) => (failureCount: number, error: unknown): boolean =>
  failureCount < times && !isForbiddenError(error)

/** The app's query defaults (main.tsx). */
export const queryDefaults = {
  refetchOnWindowFocus: false,
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
