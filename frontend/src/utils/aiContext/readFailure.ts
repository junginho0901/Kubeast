import { failureText } from '@/utils/failureText'

// A read that did not answer, as the floating chat is told it next to what the screen says: a refusal (403) with the
// reason the server gave, else the status (none when no answer came) and the reason. A list read this way has no count.
export type ReadFailure = { refused: true; reason: string } | { refused?: undefined; status?: number; reason: string }

export function readFailure(err: unknown): ReadFailure {
  const status = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status
  const reason = failureText(err)
  if (status === 403) return { refused: true, reason }
  return typeof status === 'number' ? { status, reason } : { reason }
}

/** The failure under a layer's name for the read: `<name>_refused: reason` or `<name>_failed: { status, reason }` (no name: `refused` / `failed`). */
export function failureFields(name: string, err: unknown): Record<string, unknown> {
  const f = readFailure(err)
  const key = (state: string) => (name ? `${name}_${state}` : state)
  return f.refused ? { [key('refused')]: f.reason } : { [key('failed')]: { status: f.status, reason: f.reason } }
}
