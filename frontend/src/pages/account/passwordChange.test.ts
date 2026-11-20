import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wrongCurrentPassword } from './passwordChange'

// A typo in the current password stays in the Change password window: the server's 403 with its reason is said under
// the field, and the API client signs out on a 401 only.

const answered = (status: number, data?: unknown) => ({ response: { status, data } })

describe('the current password the server refused', () => {
  it('is the 403 with the reason password_mismatch', () => {
    expect(wrongCurrentPassword(answered(403, { detail: 'Invalid current password', reason: 'password_mismatch' }))).toBe(true)
  })

  it('is no other failure, which the window shows with its reason above the form', () => {
    for (const other of [
      answered(401, { detail: 'Invalid current password' }),
      answered(401, { reason: 'password_mismatch' }),
      answered(403, { detail: 'An API key token cannot do this; it is for a signed-in person' }),
      answered(403, { reason: 'reauthentication_required' }),
      answered(400, { detail: 'Current password required' }),
      answered(409, { detail: 'e2e stand-in: the server said no' }),
      answered(503, { detail: 'audit unavailable' }),
      new Error('Network Error'),
      null,
      undefined,
    ]) {
      expect(wrongCurrentPassword(other), JSON.stringify(other)).toBe(false)
    }
  })
})

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

describe('a refused change through the API client', () => {
  let assigned: string[] = []
  let calls: string[] = []

  beforeEach(() => {
    // the API client's sign-out guard is module state: each case starts with fresh modules
    vi.resetModules()
    assigned = []
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response('{}')
    }))
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      localStorage: storage(),
      sessionStorage: storage(),
      location: { pathname: '/account', search: '', assign: (to: string) => assigned.push(to) },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function changeAnswered(status: number, data: unknown): Promise<unknown> {
    const { client } = await import('@/services/api/client')
    const { authApi } = await import('@/services/api/auth')
    client.defaults.adapter = (config: InternalAxiosRequestConfig) =>
      Promise.reject(new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, { status, statusText: '', data, headers: {}, config }))
    return authApi.changePassword({ current_password: 'typo', new_password: 'Another-long-phrase-77' }).then(
      () => null,
      (e: unknown) => e,
    )
  }

  it('leaves the person signed in on the page, the field saying why', async () => {
    const error = await changeAnswered(403, { detail: 'Invalid current password', reason: 'password_mismatch' })
    expect(wrongCurrentPassword(error)).toBe(true)
    expect({ assigned, calls }).toEqual({ assigned: [], calls: [] })
  })

  it('where the 401 auth-service gave before signed the person out', async () => {
    const error = await changeAnswered(401, { detail: 'Invalid current password' })
    expect(wrongCurrentPassword(error)).toBe(false)
    expect({ assigned, calls }).toEqual({ assigned: ['/login'], calls: ['/api/v1/auth/logout?end_sign_in=false'] })
  })
})
