// Signing out and signing in end what the tab held for the session before (services/auth onSessionChange): the live
// watch socket closes and both chats' answers stop, so the next person's lists go on a socket opened with their own
// cookie and their chats start empty, with no reload between the two.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  sent: string[] = []
  onmessage: ((evt: { data: string }) => void) | null = null
  onclose: ((evt?: { code?: number }) => void) | null = null
  private handlers = new Map<string, Set<() => void>>()

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.handlers.get('close')?.forEach((fn) => fn())
    this.onclose?.()
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.handlers.get('open')?.forEach((fn) => fn())
  }

  addEventListener(event: string, fn: () => void) {
    const set = this.handlers.get(event) ?? new Set()
    set.add(fn)
    this.handlers.set(event, set)
  }

  removeEventListener(event: string, fn: () => void) {
    this.handlers.get(event)?.delete(fn)
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

const WATCH = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/namespaces/team-a/configmaps', query: 'watch=1' }
const NEXT_WATCH = { ...WATCH, path: '/api/v1/namespaces/team-b/configmaps' }

// A signed-in tab: a list followed on the watch socket, and an answer on its way in AI Chat and in the floating chat.
async function signedInTab() {
  const { logoutSession } = await import('./auth')
  const { authApi } = await import('./api/auth')
  const { client } = await import('./api/client')
  const { watchMultiplexer } = await import('./watchMultiplexer')
  const { chatStreamManager } = await import('./chatStreamManager')
  const { floatingChatStreamManager } = await import('./floatingChatStreamManager')

  const chatSignals: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (!String(url).includes('/ai/sessions/')) return new Response('{"success":true}')
    const signal = init.signal!
    chatSignals.push(signal)
    return new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
      },
    }))
  }))

  const frames = vi.fn()
  const sub = watchMultiplexer.subscribe(WATCH, frames)
  await flush()
  const socket = MockWebSocket.instances[0]
  socket.open()
  await sub
  const answers = [
    chatStreamManager.startSessionChat('s-1', 'which pods restarted?'),
    floatingChatStreamManager.startSessionChat('s-2', 'what is wrong on this page?'),
  ]
  await vi.advanceTimersByTimeAsync(0)
  expect(chatStreamManager.getState().isStreaming).toBe(true)
  expect(floatingChatStreamManager.getState().isStreaming).toBe(true)
  return { logoutSession, authApi, client, watchMultiplexer, chatStreamManager, floatingChatStreamManager, socket, frames, chatSignals, answers }
}

type Tab = Awaited<ReturnType<typeof signedInTab>>

async function expectNothingCarriedOver(tab: Tab) {
  expect(tab.socket.readyState).toBe(MockWebSocket.CLOSED)
  expect(tab.watchMultiplexer.follows(WATCH.clusterId, WATCH.path, WATCH.query)).toBe(false)
  expect(tab.chatSignals.map((s) => s.aborted)).toEqual([true, true])
  await Promise.all(tab.answers)
  for (const manager of [tab.chatStreamManager, tab.floatingChatStreamManager]) {
    expect(manager.getState()).toMatchObject({ status: 'idle', isStreaming: false, sessionId: null, userMessage: null, content: '', toolCalls: [] })
  }

  const sub = tab.watchMultiplexer.subscribe(NEXT_WATCH, vi.fn())
  await flush()
  expect(MockWebSocket.instances).toHaveLength(2)
  const next = MockWebSocket.instances[1]
  next.open()
  await sub
  expect(next.sent.map((m) => JSON.parse(m))).toEqual([NEXT_WATCH])
  expect(tab.frames).not.toHaveBeenCalled()
}

describe('when the person signed in changes', () => {
  beforeEach(() => {
    vi.resetModules()
    MockWebSocket.instances = []
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'test.local', pathname: '/configuration/configmaps', search: '', assign: vi.fn() },
      localStorage: { getItem: () => '1', setItem: vi.fn(), removeItem: vi.fn() },
      sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('signing out closes the live connection and stops the chat streams', async () => {
    const tab = await signedInTab()
    await tab.logoutSession()
    await expectNothingCarriedOver(tab)
  })

  it('signing in does the same, for a session that ended without a sign-out', async () => {
    const tab = await signedInTab()
    vi.spyOn(tab.client, 'post').mockResolvedValue({ data: { access_token: 'token', token_type: 'bearer', user: { id: 'u-2' } } })
    await tab.authApi.login({ email: 'second@example.com', password: 'pw' })
    await expectNothingCarriedOver(tab)
  })

  it('a refused sign-in leaves the tab as it was', async () => {
    const tab = await signedInTab()
    vi.spyOn(tab.client, 'post').mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }))
    await expect(tab.authApi.login({ email: 'second@example.com', password: 'wrong' })).rejects.toThrow('401')
    expect(tab.socket.readyState).toBe(MockWebSocket.OPEN)
    expect(tab.watchMultiplexer.follows(WATCH.clusterId, WATCH.path, WATCH.query)).toBe(true)
    expect(tab.chatSignals.map((s) => s.aborted)).toEqual([false, false])
    expect(tab.chatStreamManager.getState().isStreaming).toBe(true)
    expect(tab.floatingChatStreamManager.getState().isStreaming).toBe(true)
  })
})
