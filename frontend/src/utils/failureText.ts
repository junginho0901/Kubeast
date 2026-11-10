// A fetch() answer that was not ok, in the shape failureText reads (the JSON body's detail, else the status).
export async function responseFailure(res: Response): Promise<unknown> {
  const data = await res.json().catch(() => null)
  return { response: { status: res.status, data }, message: `Request failed with status code ${res.status}` }
}

// What a failed request says on screen: the server's reason (`detail`, as services/pkg/response and FastAPI write it;
// FastAPI's field errors are a list of `msg`), else the request's own error ("Network Error", "Request failed with
// status code 502" for a gateway page that is not JSON).
export function failureText(err: unknown): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: unknown } | null | undefined
  const detail = e?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d && typeof d === 'object' ? (d as { msg?: unknown }).msg : d)).filter((m) => typeof m === 'string' && m)
    if (msgs.length) return msgs.join('; ')
  }
  return typeof e?.message === 'string' && e.message ? e.message : String(err)
}
