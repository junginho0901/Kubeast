// What is wrong with an address typed into a URL field, checked as the server checks it, so the field says so before
// Save or Test sends it. An empty field has nothing wrong (the fields are optional or say "required" themselves).
// `hostPort` also takes host:port with no scheme, to which client-go's DefaultServerURL adds one for a kubeconfig's server.
export type UrlProblem = 'notHttp' | 'credentials' | 'query'

export function urlProblem(raw: string, { noQuery = false, hostPort = false }: { noQuery?: boolean; hostPort?: boolean } = {}): UrlProblem | null {
  const value = raw.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(hostPort && !value.includes('://') ? `https://${value}` : value)
  } catch {
    return 'notHttp'
  }
  // Chrome takes a space in a host and writes it %20 where the standard (and Go's url.Parse) refuses it
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.hostname.includes('%')) return 'notHttp'
  if (url.username || url.password) return 'credentials'
  if (noQuery && (url.search || url.hash)) return 'query'
  return null
}

export const URL_PROBLEM_TEXT: Record<UrlProblem, { key: string; defaultValue: string }> = {
  notHttp: { key: 'common.urlProblem.notHttp', defaultValue: 'Not an http or https URL: start with http:// or https:// and a host.' },
  credentials: { key: 'common.urlProblem.credentials', defaultValue: 'No user or password in the URL.' },
  query: { key: 'common.urlProblem.query', defaultValue: 'No query string (?…) or fragment (#…) in the URL.' },
}
