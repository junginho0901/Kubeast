import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only a sign-out the person asked for ends the sign-in on the server; the one the app makes after a refused request
// clears the cookie and leaves the sign-in as the server has it.

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (k: string) => values.get(k) ?? null,
    key: (i: number) => [...values.keys()][i] ?? null,
    removeItem: (k: string) => void values.delete(k),
    setItem: (k: string, v: string) => void values.set(k, v),
  }
}

let calls: string[] = []
let assigned: string[] = []

beforeEach(() => {
  vi.resetModules()
  calls = []
  assigned = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url))
    return new Response('{"success":true}')
  }))
  vi.stubGlobal('window', {
    localStorage: storage(),
    sessionStorage: storage(),
    location: { pathname: '/workloads/pods', search: '?cluster=self', assign: (to: string) => assigned.push(to) },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('who ends the sign-in on the server', () => {
  it('a sign-out the person asked for asks the server to end the sign-in', async () => {
    const { logoutSession } = await import('./auth')
    await logoutSession({ asked: true })
    expect(calls).toEqual(['/api/v1/auth/logout'])
  })

  it('a sign-out named by nothing is one the person asked for, as the server reads a request without the flag', async () => {
    const { logoutSession } = await import('./auth')
    await logoutSession()
    expect(calls).toEqual(['/api/v1/auth/logout'])
  })

  it('the sign-out after a refused request only clears the cookie', async () => {
    const { handleUnauthorized } = await import('./auth')
    handleUnauthorized()
    expect(calls).toEqual(['/api/v1/auth/logout?end_sign_in=false'])
    expect(assigned).toEqual(['/login'])
  })

  it('a live connection the server ended goes the same way when the session is over', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response('{}', { status: String(url).endsWith('/auth/me') ? 401 : 200 })
    }))
    const { liveSessionEnded } = await import('./auth')
    expect(await liveSessionEnded(0)).toBe(false)
    expect(calls).toEqual(['/api/v1/auth/me', '/api/v1/auth/logout?end_sign_in=false'])
  })
})

// Each place that signs out says whether the person asked: the account menu, the pending page and closing the window
// of one's own password reset are the person's; the role-updated window follows a change that already ended the
// account's tokens.
describe('every sign-out in the screens says whether the person asked', () => {
  const src = path.resolve(__dirname, '..')
  const decided: Record<string, string[]> = {
    'components/Layout.tsx': ['logoutSession({ asked: true })'],
    'components/PendingApproval.tsx': ['logoutSession({ asked: true })'],
    'pages/AdminUsers.tsx': ['logoutSession({ asked: true })'],
    'pages/admin-users/ReauthModal.tsx': ['logoutSession({ asked: false })'],
    'services/auth.ts': ['logoutSession({ asked: false })'],
  }

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return sources(full)
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : []
    })
  }

  it('names each call as decided, and no call leaves it out', () => {
    const found: Record<string, string[]> = {}
    for (const file of sources(src)) {
      const calls = fs.readFileSync(file, 'utf8').match(/logoutSession\([^)]*\)/g)?.filter((c) => !c.startsWith('logoutSession({ asked }')) ?? []
      if (calls.length) found[path.relative(src, file)] = calls
    }
    expect(found).toEqual(decided)
  })
})
