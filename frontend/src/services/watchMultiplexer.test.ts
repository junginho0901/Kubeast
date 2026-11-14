// watchMultiplexer 단위 테스트.
//
// 핵심 검증: WS 가 끊겼을 때 자동 reconnect + 모든 기존 (path, query) 구독을
// 백엔드에 다시 REQUEST 하는지 확인. 이전엔 socket.onclose 가 socket=null 만
// 하고 listeners 는 그대로 살아있어서, 다음 mount 가 일어날 때까지 watch 가
// 영구 중단 (= ClusterView 의 'Deleting...' 라벨이 안 풀리던 증상의 root
// cause).
//
// jsdom 없이 node 환경에서 실행 — WebSocket 을 직접 mock 으로 교체.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketMultiplexer } from './watchMultiplexer'
import { getWatchProblem, resetWatchProblems } from './watchProblemStore'

// import.meta.env / window 는 vite 가 아니라 node 에서 실행되므로 직접 stub.
;(globalThis as any).import_meta_env_VITE_WS_URL = 'ws://test.local'
;(globalThis as any).window = {
  location: { protocol: 'http:', host: 'test.local' },
}

class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static CONNECTING = 0
  static CLOSING = 2
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  url: string
  sent: string[] = []
  onmessage: ((evt: { data: string }) => void) | null = null
  onclose: ((evt?: { code?: number }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  private eventListeners = new Map<string, Set<(payload?: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  static reset() {
    MockWebSocket.instances = []
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.fire('close')
    this.onclose?.()
  }

  addEventListener(event: string, fn: (payload?: unknown) => void) {
    const set = this.eventListeners.get(event) ?? new Set()
    set.add(fn)
    this.eventListeners.set(event, set)
  }

  removeEventListener(event: string, fn: (payload?: unknown) => void) {
    this.eventListeners.get(event)?.delete(fn)
  }

  private fire(event: string, payload?: unknown) {
    this.eventListeners.get(event)?.forEach((fn) => fn(payload))
  }

  // --- 시뮬레이션 helpers (테스트에서 호출) ---

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.fire('open')
    this.onopen?.()
  }

  simulateMessage(data: unknown) {
    const evt = { data: typeof data === 'string' ? data : JSON.stringify(data) }
    this.onmessage?.(evt)
  }

  simulateServerClose(code?: number) {
    // 서버가 일방적으로 끊은 케이스 (proxy idle timeout 등)
    this.readyState = MockWebSocket.CLOSED
    this.fire('close')
    this.onclose?.({ code })
  }
}

(globalThis as any).WebSocket = MockWebSocket

// import.meta.env 는 vitest 의 vite 환경에서 자동 주입되지만, env value 가
// 비어있으면 watchMultiplexer 가 window.location 으로 fallback. test 에서는
// 비워둬도 동작 — 위에서 window mock 셋업.

// microtask 기반 flush — fake timer 가 setTimeout 을 가로채도 영향 없음.
// promise chain 한두 단계 진행시키는 용도.
const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve()
  }
}

// 매 테스트마다 새 인스턴스를 받기 위해 모듈 리셋.

describe('WebSocketMultiplexer', () => {
  beforeEach(() => {
    MockWebSocket.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('첫 subscribe 시 WS 연결 + REQUEST 전송', async () => {
    const mux = new WebSocketMultiplexer()

    const listener = vi.fn()
    const subPromise = mux.subscribe(
      { type: 'REQUEST', clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' },
      listener,
    )
    await flush()

    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()
    ws.simulateOpen()

    const unsub = await subPromise

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      type: 'REQUEST',
      path: '/api/v1/pods',
      query: 'watch=1',
    })

    unsub()
  })

  it('같은 path+query 두 번째 subscribe 는 REQUEST 재전송 안 함 (dedup)', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const p1 = mux.subscribe(msg, vi.fn())
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await p1

    const p2 = mux.subscribe(msg, vi.fn())
    await flush()
    await p2

    // REQUEST 는 첫 구독에서 1회만 전송. 두 번째 listener 는 같은 stream 사용.
    expect(ws.sent).toHaveLength(1)
  })

  it('WS 가 close 되면 backoff 후 자동 reconnect + 기존 subscription REQUEST 재전송', async () => {
    const mux = new WebSocketMultiplexer()
    const listener = vi.fn()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const p = mux.subscribe(msg, listener)
    await flush()
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()
    await p

    expect(ws1.sent).toHaveLength(1) // 첫 REQUEST

    // 서버가 끊음
    ws1.simulateServerClose()

    // 첫 backoff 는 1s.
    await vi.advanceTimersByTimeAsync(1000)
    await flush()

    expect(MockWebSocket.instances).toHaveLength(2)
    const ws2 = MockWebSocket.instances[1]
    ws2.simulateOpen()
    await flush()

    // reconnect 후 자동으로 같은 REQUEST 재전송.
    expect(ws2.sent).toHaveLength(1)
    expect(JSON.parse(ws2.sent[0])).toMatchObject({
      type: 'REQUEST',
      path: '/api/v1/pods',
      query: 'watch=1',
    })

    // 새 socket 으로 도착한 메시지가 listener 에 전달.
    ws2.simulateMessage({ type: 'DATA', path: '/api/v1/pods', query: 'watch=1', data: { type: 'ADDED' } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'DATA' }))
  })

  it('구독자가 모두 unsubscribe 한 뒤 WS 가 끊기면 reconnect 안 함', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const subPromise = mux.subscribe(msg, vi.fn())
    await flush()
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()
    const unsub = await subPromise

    unsub() // 마지막 구독 해제

    ws1.simulateServerClose()
    await vi.advanceTimersByTimeAsync(60000) // 충분히 기다림
    await flush()

    // 새 소켓이 만들어지지 않아야 함.
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('reconnect 가 실패하면 backoff 가 늘어남 (1s → 2s → 4s)', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }
    // the longest of each wait
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9999)

    const p = mux.subscribe(msg, vi.fn())
    await flush()
    const ws1 = MockWebSocket.instances[0]
    ws1.simulateOpen()
    await p

    // 1차 끊김 → 1s 후 reconnect 시도
    ws1.simulateServerClose()
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(MockWebSocket.instances).toHaveLength(2)
    const ws2 = MockWebSocket.instances[1]

    // 2차 끊김 (open 도 못 한 채) → 2s 후 reconnect
    ws2.simulateServerClose()
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(MockWebSocket.instances).toHaveLength(2) // 아직 안 옴

    await vi.advanceTimersByTimeAsync(700)
    await flush()
    expect(MockWebSocket.instances).toHaveLength(3) // 2s 경과 후 옴
    random.mockRestore()
  })

  // A server that restarts closes every socket at one moment: each browser comes back at its own.
  it('browsers cut at one moment do not all reconnect at one moment, and none waits longer than the backoff', async () => {
    const random = vi.spyOn(Math, 'random')
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }
    const sockets: MockWebSocket[] = []
    for (let i = 0; i < 100; i += 1) {
      const mux = new WebSocketMultiplexer()
      const p = mux.subscribe(msg, vi.fn())
      await flush()
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws.simulateOpen()
      await p
      sockets.push(ws)
    }
    MockWebSocket.reset()
    sockets.forEach((ws, i) => {
      random.mockReturnValue(i / 100)
      ws.simulateServerClose()
    })

    await vi.advanceTimersByTimeAsync(499)
    expect(MockWebSocket.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(251)
    const first = MockWebSocket.instances.length
    expect(first).toBeGreaterThanOrEqual(40)
    expect(first).toBeLessThanOrEqual(60)
    await vi.advanceTimersByTimeAsync(250)
    expect(MockWebSocket.instances).toHaveLength(100)
    random.mockRestore()
  })

  it('마지막 listener unsubscribe 시 backend 에 CLOSE 전송', async () => {
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }

    const subPromise = mux.subscribe(msg, vi.fn())
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    const unsub = await subPromise

    expect(ws.sent).toHaveLength(1) // REQUEST

    unsub()
    expect(ws.sent).toHaveLength(2) // CLOSE
    expect(JSON.parse(ws.sent[1])).toMatchObject({
      type: 'CLOSE',
      path: '/api/v1/pods',
      query: 'watch=1',
    })
  })

  // A screen that changes what it watches while the socket is still connecting (a drawer whose selector arrives
  // after it opens) unsubscribes before subscribe() resolves: that watch must not be asked for, nor keep a listener.
  it('a subscription dropped while the socket connects is never requested and gets no messages', async () => {
    const mux = new WebSocketMultiplexer()
    const all = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/namespaces/a/pods', query: 'watch=1&labelSelector=' }
    const web = { ...all, query: 'watch=1&labelSelector=app%3Dweb' }
    const first = vi.fn()
    const second = vi.fn()
    void mux.subscribe(all, first)
    await flush()
    mux.unsubscribe(all, first)
    void mux.subscribe(web, second)
    await flush()

    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await flush()
    expect(ws.sent.map((m) => JSON.parse(m))).toEqual([web])

    ws.simulateMessage({ type: 'DATA', path: all.path, query: all.query, data: { type: 'ADDED', object: { name: 'client' } } })
    ws.simulateMessage({ type: 'DATA', path: web.path, query: web.query, data: { type: 'ADDED', object: { name: 'web' } } })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  // Closing a cluster's watch does not recall the frames already on their way: they must not land in the next cluster's list.
  it('a late frame of the cluster left behind does not reach the next cluster\'s subscription', async () => {
    const mux = new WebSocketMultiplexer()
    const a = { type: 'REQUEST' as const, clusterId: 'cluster-a', path: '/api/v1/pods', query: 'watch=1' }
    const b = { ...a, clusterId: 'cluster-b' }
    const p = mux.subscribe(a, vi.fn())
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    const closeA = await p
    closeA()
    const onB = vi.fn()
    await mux.subscribe(b, onB)

    ws.simulateMessage({ type: 'DATA', clusterId: 'cluster-a', path: a.path, query: a.query, data: { type: 'MODIFIED', object: { name: 'only-in-a' } } })
    expect(onB).not.toHaveBeenCalled()

    ws.simulateMessage({ type: 'DATA', clusterId: 'cluster-b', path: b.path, query: b.query, data: { type: 'MODIFIED', object: { name: 'in-b' } } })
    expect(onB).toHaveBeenCalledTimes(1)
    expect(onB.mock.calls[0][0].data.object.name).toBe('in-b')
  })

  it('the same path on two clusters is two subscriptions, each with its own frames, CLOSE and reconnect', async () => {
    const mux = new WebSocketMultiplexer()
    const a = { type: 'REQUEST' as const, clusterId: 'cluster-a', path: '/api/v1/pods', query: 'watch=1' }
    const b = { ...a, clusterId: 'cluster-b' }
    const onA = vi.fn()
    const onB = vi.fn()
    const p = mux.subscribe(a, onA)
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await p
    await mux.subscribe(b, onB)
    expect(ws.sent.map((m) => JSON.parse(m))).toEqual([a, b])

    ws.simulateMessage({ type: 'DATA', clusterId: 'cluster-b', path: b.path, query: b.query, data: { type: 'ADDED', object: { name: 'in-b' } } })
    expect(onA).not.toHaveBeenCalled()
    expect(onB).toHaveBeenCalledTimes(1)

    ws.simulateServerClose()
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    const ws2 = MockWebSocket.instances[1]
    ws2.simulateOpen()
    await flush()
    // each saying it missed the gap
    expect(ws2.sent.map((m) => JSON.parse(m))).toEqual([{ ...a, resync: true }, { ...b, resync: true }])

    mux.unsubscribe(a, onA)
    expect(JSON.parse(ws2.sent[ws2.sent.length - 1])).toEqual({ ...a, type: 'CLOSE' })
    ws2.simulateMessage({ type: 'DATA', clusterId: 'cluster-b', path: b.path, query: b.query, data: { type: 'ADDED', object: { name: 'also-in-b' } } })
    expect(onB).toHaveBeenCalledTimes(2)
  })

  // During an upgrade a new screen can talk to a server that does not name the cluster yet.
  it('a frame naming no cluster still reaches the subscription of its path and query', async () => {
    const mux = new WebSocketMultiplexer()
    const pods = { type: 'REQUEST' as const, clusterId: 'cluster-a', path: '/api/v1/pods', query: 'watch=1' }
    const onPods = vi.fn()
    const onNodes = vi.fn()
    const p = mux.subscribe(pods, onPods)
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await p
    await mux.subscribe({ ...pods, path: '/api/v1/nodes' }, onNodes)

    ws.simulateMessage({ type: 'DATA', path: pods.path, query: pods.query, data: { type: 'ADDED', object: { name: 'web' } } })
    expect(onPods).toHaveBeenCalledTimes(1)
    expect(onNodes).not.toHaveBeenCalled()
  })

  it('a subscription dropped before its REQUEST goes out on an open socket sends no REQUEST', async () => {
    const mux = new WebSocketMultiplexer()
    const pods = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/pods', query: 'watch=1' }
    const nodes = { ...pods, path: '/api/v1/nodes' }
    const p = mux.subscribe(pods, vi.fn())
    await flush()
    MockWebSocket.instances[0].simulateOpen()
    await p
    const ws = MockWebSocket.instances[0]
    ws.sent = []

    const listener = vi.fn()
    void mux.subscribe(nodes, listener)
    mux.unsubscribe(nodes, listener) // before subscribe() gets past its await
    await flush()
    expect(ws.sent.map((m) => JSON.parse(m).type)).not.toContain('REQUEST')
  })
  it('an ERROR frame reaches what the screen says, and the watch answering or closing clears it', async () => {
    resetWatchProblems()
    const mux = new WebSocketMultiplexer()
    const msg = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/pods', query: 'watch=1' }
    const listener = vi.fn()
    const sub = mux.subscribe(msg, listener)
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await sub

    ws.simulateMessage({ type: 'ERROR', clusterId: 'self', path: msg.path, query: msg.query, error: { message: 'x', reason: 'forbidden' } })
    expect(getWatchProblem()).toBe('forbidden')
    ws.simulateMessage({ type: 'RESYNC', clusterId: 'self', path: msg.path, query: msg.query })
    expect(getWatchProblem()).toBeUndefined()

    ws.simulateMessage({ type: 'ERROR', clusterId: 'self', path: msg.path, query: msg.query, error: { message: 'x', reason: 'limit' } })
    expect(getWatchProblem()).toBe('limit')
    mux.unsubscribe(msg, listener)
    expect(getWatchProblem()).toBeUndefined()
  })

  describe('a watch refused a place', () => {
    const open = async (mux: WebSocketMultiplexer, msgs: Array<{ type: 'REQUEST'; clusterId: string; path: string; query: string }>, listener: () => void) => {
      const subs = msgs.map((msg) => mux.subscribe(msg, listener))
      await flush()
      const ws = MockWebSocket.instances[0]
      ws.simulateOpen()
      await Promise.all(subs)
      return ws
    }
    const sentOf = (ws: MockWebSocket) => ws.sent.map((raw) => JSON.parse(raw))
    const refuse = (ws: MockWebSocket, msg: { path: string; query: string }) =>
      ws.simulateMessage({ type: 'ERROR', clusterId: 'self', path: msg.path, query: msg.query, error: { message: 'max subscriptions', reason: 'limit' } })

    const first = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/pods', query: 'watch=1' }
    const second = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/services', query: 'watch=1' }

    beforeEach(() => resetWatchProblems())

    it('asks again by itself, once the wait has passed, saying it missed what came meanwhile', async () => {
      const mux = new WebSocketMultiplexer()
      const ws = await open(mux, [first], vi.fn())
      expect(sentOf(ws)).toHaveLength(1)
      refuse(ws, first)
      expect(getWatchProblem()).toBe('limit')

      // nothing is asked at once: hundreds of tabs were refused together
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sentOf(ws)).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(5 * 60_000)
      const asks = sentOf(ws)
      expect(asks.length).toBeGreaterThan(1)
      expect(asks[1]).toMatchObject({ type: 'REQUEST', path: first.path, query: first.query, resync: true })
    })

    it('waits longer each time it is refused again, so a full server is asked less and less', async () => {
      const mux = new WebSocketMultiplexer()
      const ws = await open(mux, [first], vi.fn())
      refuse(ws, first)
      const when: number[] = []
      for (let i = 0; i < 4; i += 1) {
        const before = sentOf(ws).length
        const start = Date.now()
        for (let waited = 0; waited < 10 * 60_000 && sentOf(ws).length === before; waited += 1000) await vi.advanceTimersByTimeAsync(1000)
        expect(sentOf(ws).length).toBe(before + 1)
        when.push(Date.now() - start)
        refuse(ws, first)
      }
      // 30 s, 60 s, 120 s, 240 s, each between half and one and a half of that
      expect(when[0]).toBeLessThanOrEqual(45_000)
      expect(when[3]).toBeGreaterThanOrEqual(120_000)
    })

    it('asks at once when this tab closes a watch of its own, which frees a place the server would give it', async () => {
      const mux = new WebSocketMultiplexer()
      const listener = vi.fn()
      const ws = await open(mux, [first, second], listener)
      refuse(ws, second)
      expect(sentOf(ws)).toHaveLength(2)

      mux.unsubscribe(first, listener)
      const asks = sentOf(ws)
      expect(asks[2]).toMatchObject({ type: 'CLOSE', path: first.path })
      expect(asks[3]).toMatchObject({ type: 'REQUEST', path: second.path, resync: true })
    })

    it('stops asking once the watch answers, and when nobody follows it any more', async () => {
      const mux = new WebSocketMultiplexer()
      const listener = vi.fn()
      const ws = await open(mux, [first, second], listener)
      refuse(ws, first)
      refuse(ws, second)

      ws.simulateMessage({ type: 'RESYNC', clusterId: 'self', path: first.path, query: first.query })
      mux.unsubscribe(second, listener)
      const before = sentOf(ws).filter((m) => m.type === 'REQUEST').length
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(sentOf(ws).filter((m) => m.type === 'REQUEST').length).toBe(before)
    })

    it('another refusal is not asked again: the grant or the kind decides those', async () => {
      const mux = new WebSocketMultiplexer()
      const ws = await open(mux, [first], vi.fn())
      ws.simulateMessage({ type: 'ERROR', clusterId: 'self', path: first.path, query: first.query, error: { message: 'x', reason: 'scope' } })
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(sentOf(ws)).toHaveLength(1)
    })

    it('a socket that comes back asks once for everything, not again for the refused ones', async () => {
      const mux = new WebSocketMultiplexer()
      const ws1 = await open(mux, [first], vi.fn())
      refuse(ws1, first)
      ws1.simulateServerClose()
      await vi.advanceTimersByTimeAsync(40_000)
      const ws2 = MockWebSocket.instances[1]
      ws2.simulateOpen()
      await flush()
      expect(sentOf(ws2)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(20 * 60_000)
      expect(sentOf(ws2)).toHaveLength(1)
    })
  })

  describe('a watch of changes', () => {
    const changes = { type: 'REQUEST' as const, clusterId: 'self', path: '/apis/rbac.authorization.k8s.io/v1/clusterroles', query: 'watch=1&notify=1' }
    const list = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/pods', query: 'watch=1' }

    it('reaches its listener', async () => {
      const mux = new WebSocketMultiplexer()
      const listener = vi.fn()
      const sub = mux.subscribe(changes, listener)
      await flush()
      const ws = MockWebSocket.instances[0]
      ws.simulateOpen()
      await sub
      ws.simulateMessage({ type: 'CHANGED', clusterId: 'self', path: changes.path, query: changes.query })
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'CHANGED' }))
    })

    // It sends no objects as it opens, and a list's watch sends the objects there are and not those deleted while the
    // socket was gone: both say they missed something, and the server's RESYNC has the list read again.
    it('says it missed something when its socket comes back, and so does a list\'s watch', async () => {
      const mux = new WebSocketMultiplexer()
      const listener = vi.fn()
      const subs = [mux.subscribe(changes, listener), mux.subscribe(list, listener)]
      await flush()
      const ws1 = MockWebSocket.instances[0]
      ws1.simulateOpen()
      await Promise.all(subs)
      expect(ws1.sent.map((raw) => JSON.parse(raw).resync)).toEqual([undefined, undefined])

      ws1.simulateServerClose()
      await vi.advanceTimersByTimeAsync(40_000)
      const ws2 = MockWebSocket.instances[1]
      ws2.simulateOpen()
      await flush()
      const asks = ws2.sent.map((raw) => JSON.parse(raw))
      expect(asks.find((m) => m.path === changes.path)).toMatchObject({ resync: true })
      expect(asks.find((m) => m.path === list.path)).toMatchObject({ resync: true })
    })
  })

  // What the reconnect asks of the server, through the list it feeds: the server answers resync with one RESYNC once the
  // watch is on (k8s-service followWatch), and the list is read again, without the row deleted while the socket was gone.
  describe('a list whose socket came back', () => {
    const path = '/apis/apps/v1/namespaces/demo/deployments'
    const listKey = ['workloads', 'deployments', 'demo']

    const follow = async () => {
      vi.resetModules()
      const { followList } = await import('./useKubeWatchList')
      const { QueryClient, QueryObserver } = await import('@tanstack/react-query')
      const client = new QueryClient()
      let rows = [{ name: 'api', namespace: 'demo' }, { name: 'web', namespace: 'demo' }]
      const queryFn = vi.fn(async () => rows)
      const stopObserver = new QueryObserver(client, { queryKey: listKey, queryFn }).subscribe(() => {})
      const stopList = followList(client, { clusterId: 'self', paths: [path], query: 'watch=1', queryKey: listKey })
      await flush()
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws.simulateOpen()
      await vi.advanceTimersByTimeAsync(0)
      return {
        ws,
        queryFn,
        rows: () => client.getQueryData(listKey),
        deleteMeanwhile: (name: string) => (rows = rows.filter((row) => row.name !== name)),
        stop: () => { stopList(); stopObserver() },
      }
    }
    // The server: a frame per object as a watch from no version opens, and a RESYNC first when the request asks for one.
    const serve = (ws: MockWebSocket, objects: string[]) => {
      for (const raw of ws.sent) {
        const ask = JSON.parse(raw)
        if (ask.type !== 'REQUEST') continue
        if (ask.resync) ws.simulateMessage({ type: 'RESYNC', clusterId: 'self', path, query: 'watch=1' })
        for (const name of objects) ws.simulateMessage({ type: 'DATA', clusterId: 'self', path, query: 'watch=1', data: { type: 'ADDED', object: { name, namespace: 'demo' } } })
      }
    }

    it('drops a row deleted while the socket was gone, once the list is read again', async () => {
      const list = await follow()
      serve(list.ws, ['api', 'web'])
      expect(list.rows()).toEqual([{ name: 'api', namespace: 'demo' }, { name: 'web', namespace: 'demo' }])

      list.ws.simulateServerClose()
      list.deleteMeanwhile('api')
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      expect(ws2).not.toBe(list.ws)
      ws2.simulateOpen()
      await flush()
      serve(ws2, ['web'])
      // the read waits its share of five seconds, the rows on screen until then
      await vi.advanceTimersByTimeAsync(5000)
      expect(list.queryFn).toHaveBeenCalledTimes(2)
      expect(list.rows()).toEqual([{ name: 'web', namespace: 'demo' }])
      list.stop()
    })

    it('a tab that is hidden reads it once it shows again', async () => {
      const { focusManager } = await import('@tanstack/react-query')
      const list = await follow()
      serve(list.ws, ['api', 'web'])
      list.ws.simulateServerClose()
      list.deleteMeanwhile('api')
      focusManager.setFocused(false)
      try {
        await vi.advanceTimersByTimeAsync(1000)
        await flush()
        const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]
        ws2.simulateOpen()
        await flush()
        serve(ws2, ['web'])
        await vi.advanceTimersByTimeAsync(60_000)
        expect(list.queryFn).toHaveBeenCalledTimes(1)
        expect(list.rows()).toEqual([{ name: 'api', namespace: 'demo' }, { name: 'web', namespace: 'demo' }])
        focusManager.setFocused(true)
        await vi.advanceTimersByTimeAsync(0)
        expect(list.queryFn).toHaveBeenCalledTimes(2)
        expect(list.rows()).toEqual([{ name: 'web', namespace: 'demo' }])
      } finally {
        focusManager.setFocused(undefined)
        list.stop()
      }
    })
  })

  it('says whether a list is followed on this cluster, which a drawer on that list can share', async () => {
    const mux = new WebSocketMultiplexer()
    const listener = vi.fn()
    const msg = { type: 'REQUEST' as const, clusterId: 'self', path: '/apis/apps/v1/deployments', query: 'watch=1' }
    const sub = mux.subscribe(msg, listener)
    await flush()
    MockWebSocket.instances[0].simulateOpen()
    await sub
    expect(mux.follows('self', msg.path, msg.query)).toBe(true)
    expect(mux.follows('other', msg.path, msg.query)).toBe(false)
    expect(mux.follows('self', msg.path, 'watch=1&fieldSelector=x')).toBe(false)
    mux.unsubscribe(msg, listener)
    expect(mux.follows('self', msg.path, msg.query)).toBe(false)
  })

  it('says whether a frame has answered a watch on this socket, which a drawer that joins it would not hear', async () => {
    const mux = new WebSocketMultiplexer()
    const listener = vi.fn()
    const msg = { type: 'REQUEST' as const, clusterId: 'self', path: '/apis/apps/v1/deployments', query: 'watch=1' }
    const sub = mux.subscribe(msg, listener)
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await sub
    expect(mux.answers('self', msg.path, msg.query)).toBe(false)
    ws.simulateMessage({ type: 'DATA', clusterId: 'self', path: msg.path, query: msg.query, data: { type: 'ADDED', object: { name: 'web' } } })
    expect(mux.answers('self', msg.path, msg.query)).toBe(true)
    expect(mux.answers('other', msg.path, msg.query)).toBe(false)
    ws.simulateMessage({ type: 'ERROR', clusterId: 'self', path: msg.path, query: msg.query, error: { message: 'x', reason: 'unreachable' } })
    expect(mux.answers('self', msg.path, msg.query)).toBe(false)
    ws.simulateMessage({ type: 'RESYNC', clusterId: 'self', path: msg.path, query: msg.query })
    expect(mux.answers('self', msg.path, msg.query)).toBe(true)
    ws.simulateServerClose()
    expect(mux.answers('self', msg.path, msg.query)).toBe(false)
  })

  it('tells who asks when its socket closed', async () => {
    const mux = new WebSocketMultiplexer()
    const closed = vi.fn()
    const off = mux.onSocketClosed(closed)
    const p = mux.subscribe({ type: 'REQUEST', clusterId: 'self', path: '/api/v1/pods', query: 'watch=1' }, vi.fn())
    await flush()
    const ws = MockWebSocket.instances[0]
    ws.simulateOpen()
    await p
    ws.simulateServerClose()
    expect(closed).toHaveBeenCalledTimes(1)
    off()
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    MockWebSocket.instances[1].simulateServerClose()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  describe('a watch the limit refused', () => {
    const msg = { type: 'REQUEST' as const, clusterId: 'self', path: '/api/v1/namespaces/demo/configmaps', query: 'watch=1' }
    const refusal = { type: 'ERROR', clusterId: msg.clusterId, path: msg.path, query: msg.query, error: { message: 'max subscriptions reached for the server (2000), cannot create new watch', reason: 'limit', limit_scope: 'server' } }
    const requests = (ws: MockWebSocket) => ws.sent.map((m) => JSON.parse(m)).filter((m) => m.type === 'REQUEST')
    const open = async (listener = vi.fn()) => {
      resetWatchProblems()
      const mux = new WebSocketMultiplexer()
      const p = mux.subscribe(msg, listener)
      await flush()
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws.simulateOpen()
      await p
      return { mux, ws, listener }
    }

    afterEach(() => {
      vi.restoreAllMocks()
      ;(globalThis as any).document = undefined
    })

    it('asks again on its own within a minute, with no new page and no reload', async () => {
      const { ws } = await open()
      expect(requests(ws)).toHaveLength(1)
      ws.simulateMessage(refusal)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(requests(ws).length).toBeGreaterThanOrEqual(2)
      expect(requests(ws)[1]).toEqual({ ...msg, resync: true })
    })

    it('asks no sooner than half its first wait and at a time of its own, so a crowd refused together does not ask together', async () => {
      const asked: number[] = []
      const random = vi.spyOn(Math, 'random')
      for (const r of [0, 0.5, 0.9999]) {
        random.mockReturnValue(r)
        const { ws } = await open()
        ws.simulateMessage(refusal)
        const started = Date.now()
        for (let ms = 0; ms < 70_000 && requests(ws).length < 2; ms += 1000) await vi.advanceTimersByTimeAsync(1000)
        asked.push(Date.now() - started)
      }
      expect(Math.min(...asked)).toBeGreaterThanOrEqual(15_000)
      expect(Math.max(...asked)).toBeLessThanOrEqual(45_000)
      expect(Math.max(...asked) - Math.min(...asked)).toBeGreaterThanOrEqual(20_000)
    })

    it('goes on asking while it is refused', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9999)
      const { ws } = await open()
      ws.simulateMessage(refusal)
      for (let i = 0; i < 4; i += 1) {
        const before = requests(ws).length
        // the longest of each wait, 45 s, 90 s, 180 s, 360 s
        await vi.advanceTimersByTimeAsync(45_000 * 2 ** i)
        expect(requests(ws)).toHaveLength(before + 1)
        ws.simulateMessage(refusal)
      }
      expect(requests(ws).length).toBeGreaterThanOrEqual(5)
      expect(getWatchProblem()).toBe('server_limit')
    })

    it('leaves reading the list to the RESYNC the server sends once it gives the place, on an empty list too', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.9999)
      const { ws, listener } = await open()
      ws.simulateMessage(refusal)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(requests(ws)[1]).toEqual({ ...msg, resync: true })
      listener.mockClear()
      await vi.advanceTimersByTimeAsync(10_000)
      // nothing is made up here: the server's frame is what says the watch is on
      expect(listener).not.toHaveBeenCalled()
      ws.simulateMessage({ type: 'RESYNC', clusterId: msg.clusterId, path: msg.path, query: msg.query })
      expect(listener.mock.calls.map(([m]) => m.type)).toEqual(['RESYNC'])
      expect(getWatchProblem()).toBeUndefined()
      const asked = requests(ws).length
      await vi.advanceTimersByTimeAsync(300_000)
      expect(requests(ws)).toHaveLength(asked)
    })

    it('stops asking once the screen closed it', async () => {
      const { mux, ws, listener } = await open()
      ws.simulateMessage(refusal)
      mux.unsubscribe(msg, listener)
      const asked = requests(ws).length
      await vi.advanceTimersByTimeAsync(300_000)
      expect(requests(ws)).toHaveLength(asked)
    })

    it('does not ask from a hidden tab, and asks when the tab shows again', async () => {
      const { ws } = await open()
      ;(globalThis as any).document = { visibilityState: 'hidden' }
      ws.simulateMessage(refusal)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(requests(ws)).toHaveLength(1)
      ;(globalThis as any).document = { visibilityState: 'visible' }
      await vi.advanceTimersByTimeAsync(60_000)
      expect(requests(ws).length).toBeGreaterThanOrEqual(2)
    })

    it('a reconnect asks for it with the rest, and only once', async () => {
      const { ws } = await open()
      ws.simulateMessage(refusal)
      ws.simulateServerClose()
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws2.simulateOpen()
      await flush()
      expect(requests(ws2)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(300_000)
      expect(requests(ws2)).toHaveLength(1)
    })

    it('another problem of the same watch leaves it to the server, which keeps trying', async () => {
      const { ws } = await open()
      ws.simulateMessage(refusal)
      await vi.advanceTimersByTimeAsync(60_000)
      ws.simulateMessage({ ...refusal, error: { message: 'nope', reason: 'forbidden' } })
      const asked = requests(ws).length
      await vi.advanceTimersByTimeAsync(300_000)
      expect(requests(ws)).toHaveLength(asked)
      expect(getWatchProblem()).toBe('forbidden')
    })

    it('a hidden tab that closes a watch gives its place away and does not ask for it', async () => {
      const other = { ...msg, path: '/api/v1/namespaces/demo/secrets' }
      const { mux, ws, listener } = await open()
      await mux.subscribe(other, listener)
      ws.simulateMessage({ ...refusal, path: other.path })
      ;(globalThis as any).document = { visibilityState: 'hidden' }
      mux.unsubscribe(msg, listener)
      expect(requests(ws)).toHaveLength(2)
      ;(globalThis as any).document = { visibilityState: 'visible' }
      await vi.advanceTimersByTimeAsync(60_000)
      expect(requests(ws)[2]).toEqual({ ...other, resync: true })
    })
  })

  describe('the session of a socket ended', () => {
    // A fresh module each time: services/auth signs out once per page load, and remembers it in a module variable.
    const freshMux = async () => {
      vi.resetModules()
      const { WebSocketMultiplexer: Fresh } = await import('./watchMultiplexer')
      return new Fresh()
    }
    const open = async (mux: WebSocketMultiplexer) => {
      const sub = mux.subscribe({ type: 'REQUEST', clusterId: 'default', path: '/api/v1/pods', query: 'watch=1' }, vi.fn())
      await flush()
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
      ws.simulateOpen()
      await sub
      return ws
    }
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0)
      await flush()
    }

    beforeEach(() => {
      ;(globalThis as any).window = {
        location: { protocol: 'http:', host: 'test.local', pathname: '/pods', search: '', assign: vi.fn() },
        localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
        sessionStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
      }
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('reopens without signing out when the cookie is a newer session', async () => {
      const fetchMe = vi.fn(async () => ({ status: 200 }))
      vi.stubGlobal('fetch', fetchMe)
      const mux = await freshMux()
      const ws = await open(mux)

      ws.simulateServerClose(4401)
      await settle()
      expect(fetchMe).toHaveBeenCalledWith('/api/v1/auth/me', { credentials: 'same-origin' })
      expect((globalThis as any).window.location.assign).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      expect(MockWebSocket.instances.length).toBe(2)
    })

    it('goes to the sign-in page and does not reopen when the session is over', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ status: url.endsWith('/auth/me') ? 401 : 200 })))
      const mux = await freshMux()
      const ws = await open(mux)

      ws.simulateServerClose(4401)
      await settle()
      expect((globalThis as any).window.location.assign).toHaveBeenCalledWith('/login')

      await vi.advanceTimersByTimeAsync(60000)
      expect(MockWebSocket.instances.length).toBe(1)
    })

    it('a second end right after reopening is the same session: it goes to the sign-in page', async () => {
      const fetchMe = vi.fn(async () => ({ status: 200 }))
      vi.stubGlobal('fetch', fetchMe)
      const mux = await freshMux()
      const ws = await open(mux)

      ws.simulateServerClose(4401)
      await settle()
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      const reopened = MockWebSocket.instances[1]
      reopened.simulateOpen()
      await flush()
      fetchMe.mockClear()

      reopened.simulateServerClose(4401)
      await settle()
      expect((globalThis as any).window.location.assign).toHaveBeenCalledWith('/login')
      await vi.advanceTimersByTimeAsync(60000)
      expect(MockWebSocket.instances.length).toBe(2)
    })

    it('another close keeps reconnecting and asks nothing', async () => {
      const fetchMe = vi.fn(async () => ({ status: 200 }))
      vi.stubGlobal('fetch', fetchMe)
      const mux = await freshMux()
      const ws = await open(mux)

      ws.simulateServerClose(1006)
      await settle()
      expect(fetchMe).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
      expect(MockWebSocket.instances.length).toBe(2)
    })
  })
})
