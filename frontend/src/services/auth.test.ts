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

// A server that could not check the session (a 503 while its database restarts, no answer) has said nothing about the
// sign-in: nothing here signs the person out for it. The server's own answer that the sign-in is over still does.
describe('a session the server could not check is no sign-out', () => {
  const answered = (status: number) => ({ response: { status } })

  it('only an answer of 4xx to /auth/me sends the page to sign in', async () => {
    const { retrySessionRead, sessionReadSaysSignedOut, signInAfterSessionRead } = await import('./auth')
    expect(sessionReadSaysSignedOut(answered(401))).toBe(true)
    expect(sessionReadSaysSignedOut(answered(403))).toBe(true)
    for (const unanswered of [answered(503), answered(502), answered(500), new Error('timeout of 10000ms exceeded'), undefined]) {
      expect(sessionReadSaysSignedOut(unanswered)).toBe(false)
      expect(signInAfterSessionRead(unanswered, true)).toBe(false)
      expect(retrySessionRead(0, unanswered)).toBe(true)
    }
    expect(signInAfterSessionRead(answered(401), true)).toBe(true)
    expect(retrySessionRead(0, answered(401))).toBe(false)
    // a page with no session read yet goes to sign in once the retries are spent, as before
    expect(signInAfterSessionRead(answered(503), false)).toBe(true)
  })

  it('every screen that sends the page to sign in on a failed /auth/me read asks the same rule', () => {
    const src = path.resolve(__dirname, '..')
    for (const file of ['components/RequireAuth.tsx', 'components/RequirePermission.tsx', 'components/Layout.tsx']) {
      expect(fs.readFileSync(path.join(src, file), 'utf8'), file).toContain('signInAfterSessionRead(')
    }
  })

  it('a live connection whose session could not be checked opens again', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response('{"detail":"Session could not be checked; try again"}', { status: 503 })
    }))
    const { liveSessionEnded } = await import('./auth')
    expect(await liveSessionEnded(0)).toBe(true)
    expect(calls).toEqual(['/api/v1/auth/me'])
    expect(assigned).toEqual([])
  })

  it('a refresh the server could not make is asked again at the next minute, not half a token lifetime later', async () => {
    vi.useFakeTimers()
    try {
      const answers = [503, 200]
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(String(url))
        return new Response('{}', { status: answers.shift() ?? 200 })
      }))
      const activity = new Map<string, () => void>()
      vi.stubGlobal('window', {
        ...window,
        addEventListener: (ev: string, fn: () => void) => activity.set(ev, fn),
        removeEventListener: () => undefined,
        setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
        clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
      })
      vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined })
      const { startSessionKeepalive } = await import('./auth')
      const refreshes = () => calls.filter((c) => c === '/api/v1/auth/refresh').length

      const stop = startSessionKeepalive(15) // the token lives 15 minutes and is re-issued after 7.5
      await vi.advanceTimersByTimeAsync(1000)
      activity.get('keydown')?.()
      await vi.advanceTimersByTimeAsync(8 * 60 * 1000)
      expect(refreshes()).toBe(1) // the 503
      await vi.advanceTimersByTimeAsync(60 * 1000)
      expect(refreshes()).toBe(2) // asked again a minute later
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      expect(refreshes()).toBe(2) // re-issued: nothing more until the next activity
      expect(assigned).toEqual([])
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
