import type { APIResponse } from '@playwright/test'

// The sign-in token of a password sign-in or refresh answer, read from its Set-Cookie header. auth-service names the
// cookie kubeast.token, or __Host-kubeast.token on an https install; both are read, the __Host- one first.
const NAMES = ['__Host-kubeast.token', 'kubeast.token']

export function sessionToken(res: APIResponse): string {
  const set = new Map<string, string>()
  for (const { name, value } of res.headersArray()) {
    if (name.toLowerCase() !== 'set-cookie') continue
    const pair = value.split(';', 1)[0]
    const eq = pair.indexOf('=')
    if (eq > 0 && pair.slice(eq + 1).trim()) set.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  const name = NAMES.find((n) => set.has(n))
  if (!name) throw new Error(`${res.url()} answered ${res.status()} with no ${NAMES.join(' or ')} cookie`)
  return set.get(name) as string
}
