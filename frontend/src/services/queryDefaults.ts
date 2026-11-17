import { isForbiddenError } from '@/services/api'

// A read refused (403) answers the same until the person's access changes: it is not tried again, nor asked again on a
// timer. Opening the screen again or choosing another cluster asks once more, as for a refused metrics read
// (metricsReadPace). Another failure is tried once more.

/** The app's query defaults (main.tsx). */
export const queryDefaults = {
  refetchOnWindowFocus: false,
  retry: (failureCount: number, error: unknown): boolean => failureCount < 1 && !isForbiddenError(error),
}

/** A read asked again every `ms` until it is refused. */
export const everyUntilRefused = (ms: number) => (query: { state: { error: unknown } }): number | false =>
  isForbiddenError(query.state.error) ? false : ms
