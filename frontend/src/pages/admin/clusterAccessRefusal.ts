// What the server said when it refused a cluster access read or change (its reason in `detail`), else the request's
// own error; null without an error.
export function refusalText(err: unknown): string | null {
  if (!err) return null
  const e = err as { response?: { data?: { detail?: unknown } }; message?: unknown }
  const detail = e.response?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  return typeof e.message === 'string' && e.message ? e.message : String(err)
}
