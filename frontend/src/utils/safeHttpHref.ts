// A link's href for an address the console did not write (an alert's Alertmanager addresses; the webhook stores only
// http and https ones, rows from before it did hold what it received): the address as the browser reads it when that is
// an absolute http or https URL with a host, else null and the caller shows it as words. Any other scheme (javascript:,
// data:, vbscript:, …), a path on the console's own host and an empty value are not links; tabs and spaces are read as
// the browser reads them, then checked. safeHttpHref.cases.json holds it and the webhook's stored_address to one list.
export function safeHttpHref(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : null
}
